import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { openDatabase } from "../server/db.js";
import {
  connectYandex,
  refreshYandexConnection,
  withYandexConnection,
} from "../server/oauth.js";
import { ProviderError } from "../server/providers.js";
import { decrypt, encrypt } from "../server/security.js";

function fixture() {
  const db = openDatabase(":memory:"),
    key = randomBytes(32),
    userId = randomUUID(),
    business = { id: randomUUID() };
  db.prepare("INSERT INTO users VALUES(?,?,?,?)").run(
    userId,
    "google:oauth-test",
    "Tester",
    new Date().toISOString(),
  );
  db.prepare("INSERT INTO businesses VALUES(?,?,?,1)").run(
    business.id,
    userId,
    JSON.stringify({ mode: "live" }),
  );
  return {
    db,
    key,
    business,
    config: {
      sandbox: false,
      yandexId: "client-id",
      yandexSecret: "client-secret",
    },
  };
}

test("Yandex connection keeps an encrypted token when Direct validation times out", async () => {
  const f = fixture();
  try {
    const metadata = await connectYandex({
      ...f,
      data: { access_token: "new-token", refresh_token: "refresh" },
      directFactory: () => ({
        clients: async () => {
          throw new ProviderError("timeout", true);
        },
      }),
    });
    const row = f.db
      .prepare("SELECT * FROM connections WHERE business_id=?")
      .get(f.business.id);
    assert.ok(row.encrypted);
    assert.equal(row.encrypted.includes("new-token"), false);
    assert.equal(
      decrypt(row.encrypted, f.key, f.business.id + ":yandex").access_token,
      "new-token",
    );
    assert.equal(metadata.validation, "pending");
    assert.deepEqual(metadata.clients, []);
  } finally {
    f.db.close();
  }
});

test("Yandex connection records verified Direct clients", async () => {
  const f = fixture();
  try {
    const metadata = await connectYandex({
      ...f,
      data: { access_token: "verified-token" },
      directFactory: () => ({
        clients: async () => ({
          Clients: [{ Login: "client-login", ClientId: 42, Currency: "RUB" }],
        }),
      }),
    });
    assert.equal(metadata.validation, "verified");
    assert.equal(metadata.clients[0].Login, "client-login");
    assert.ok(metadata.validatedAt);
  } finally {
    f.db.close();
  }
});

test("failed non-retryable validation restores the previous connection", async () => {
  const f = fixture(),
    previousMetadata = JSON.stringify({
      clients: [{ Login: "old-login" }],
      sandbox: false,
      validation: "verified",
    }),
    previousEncrypted = encrypt(
      { access_token: "old-token" },
      f.key,
      f.business.id + ":yandex",
    );
  f.db
    .prepare("INSERT INTO connections VALUES(?,?,?,?)")
    .run(f.business.id, "yandex", previousEncrypted, previousMetadata);
  try {
    await assert.rejects(
      connectYandex({
        ...f,
        data: { access_token: "invalid-token" },
        directFactory: () => ({
          clients: async () => {
            throw new ProviderError("denied", false);
          },
        }),
      }),
      /denied/,
    );
    const row = f.db
      .prepare("SELECT encrypted,metadata FROM connections WHERE business_id=?")
      .get(f.business.id);
    assert.equal(row.encrypted, previousEncrypted);
    assert.equal(row.metadata, previousMetadata);
  } finally {
    f.db.close();
  }
});

test("expired Yandex credentials are atomically refreshed and rotated", async () => {
  const f = fixture(),
    now = Date.UTC(2026, 9, 28),
    original = encrypt(
      {
        access_token: "old-access",
        refresh_token: "old-refresh",
        expires_at: now - 1,
      },
      f.key,
      f.business.id + ":yandex",
    );
  f.db.prepare("INSERT INTO connections VALUES(?,?,?,?)").run(
    f.business.id,
    "yandex",
    original,
    JSON.stringify({
      connectionId: "connection-1",
      sandbox: false,
      clients: [],
      validation: "verified",
    }),
  );
  try {
    const result = await refreshYandexConnection({
      ...f,
      businessId: f.business.id,
      now,
      refreshToken: async (refresh, clientId, secret) => {
        assert.deepEqual([refresh, clientId, secret], [
          "old-refresh",
          "client-id",
          "client-secret",
        ]);
        return {
          access_token: "new-access",
          refresh_token: "new-refresh",
          expires_in: 3600,
        };
      },
    });
    assert.equal(result.refreshed, true);
    assert.equal(result.credentials.access_token, "new-access");
    assert.equal(result.credentials.refresh_token, "new-refresh");
    const row = f.db
      .prepare("SELECT encrypted,metadata FROM connections WHERE business_id=?")
      .get(f.business.id);
    assert.notEqual(row.encrypted, original);
    assert.equal(row.encrypted.includes("new-access"), false);
    assert.equal(
      decrypt(row.encrypted, f.key, f.business.id + ":yandex").access_token,
      "new-access",
    );
    const metadata = JSON.parse(row.metadata);
    assert.equal(metadata.connectionId, "connection-1");
    assert.ok(metadata.tokenRefreshedAt);
    assert.ok(metadata.tokenExpiresAt);
  } finally {
    f.db.close();
  }
});

test("legacy token expiry is derived from connectedAt and expires_in", async () => {
  const f = fixture(),
    now = Date.UTC(2026, 9, 28, 12);
  f.db.prepare("INSERT INTO connections VALUES(?,?,?,?)").run(
    f.business.id,
    "yandex",
    encrypt(
      {
        access_token: "legacy-access",
        refresh_token: "legacy-refresh",
        expires_in: 3600,
      },
      f.key,
      f.business.id + ":yandex",
    ),
    JSON.stringify({
      connectedAt: new Date(now - 2 * 3600 * 1000).toISOString(),
      sandbox: false,
      clients: [],
      validation: "verified",
    }),
  );
  let calls = 0;
  try {
    const result = await refreshYandexConnection({
      ...f,
      businessId: f.business.id,
      now,
      refreshToken: async () => {
        calls++;
        return {
          access_token: "fresh-access",
          refresh_token: "fresh-refresh",
          expires_in: 3600,
        };
      },
    });
    assert.equal(result.refreshed, true);
    assert.equal(calls, 1);
  } finally {
    f.db.close();
  }
});

test("concurrent refresh requests use one token exchange", async () => {
  const f = fixture(),
    now = Date.UTC(2026, 9, 28);
  f.db.prepare("INSERT INTO connections VALUES(?,?,?,?)").run(
    f.business.id,
    "yandex",
    encrypt(
      {
        access_token: "old-access",
        refresh_token: "old-refresh",
        expires_at: now - 1,
      },
      f.key,
      f.business.id + ":yandex",
    ),
    JSON.stringify({ sandbox: false, clients: [], validation: "verified" }),
  );
  let release,
    calls = 0;
  const gate = new Promise((resolve) => (release = resolve));
  const refreshToken = async () => {
    calls++;
    await gate;
    return {
      access_token: "new-access",
      refresh_token: "new-refresh",
      expires_in: 3600,
    };
  };
  try {
    const options = {
      ...f,
      businessId: f.business.id,
      now,
      refreshToken,
    };
    const first = refreshYandexConnection(options),
      second = refreshYandexConnection(options);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 1);
    release();
    const [a, b] = await Promise.all([first, second]);
    assert.equal(a.credentials.access_token, "new-access");
    assert.equal(b.credentials.access_token, "new-access");
  } finally {
    f.db.close();
  }
});

test("invalid refresh keeps encrypted credentials and requests reconnection", async () => {
  const f = fixture(),
    now = Date.UTC(2026, 9, 28),
    original = encrypt(
      {
        access_token: "old-access",
        refresh_token: "invalid-refresh",
        expires_at: now - 1,
      },
      f.key,
      f.business.id + ":yandex",
    );
  f.db.prepare("INSERT INTO connections VALUES(?,?,?,?)").run(
    f.business.id,
    "yandex",
    original,
    JSON.stringify({ sandbox: false, clients: [], validation: "verified" }),
  );
  try {
    await assert.rejects(
      refreshYandexConnection({
        ...f,
        businessId: f.business.id,
        now,
        refreshToken: async () => {
          throw new ProviderError("invalid_grant", false);
        },
      }),
      (error) => error.code === "reauth_required",
    );
    const row = f.db
      .prepare("SELECT encrypted,metadata FROM connections WHERE business_id=?")
      .get(f.business.id);
    assert.equal(row.encrypted, original);
    assert.equal(JSON.parse(row.metadata).validation, "reauth_required");
    assert.equal(row.metadata.includes("invalid_grant"), false);
  } finally {
    f.db.close();
  }
});

test("provider auth failure forces one refresh and retries the read", async () => {
  const f = fixture();
  f.db.prepare("INSERT INTO connections VALUES(?,?,?,?)").run(
    f.business.id,
    "yandex",
    encrypt(
      { access_token: "old-access", refresh_token: "refresh" },
      f.key,
      f.business.id + ":yandex",
    ),
    JSON.stringify({ sandbox: false, clients: [], validation: "verified" }),
  );
  let actions = 0,
    refreshes = 0;
  try {
    const result = await withYandexConnection(
      {
        ...f,
        businessId: f.business.id,
        refreshToken: async () => {
          refreshes++;
          return {
            access_token: "new-access",
            refresh_token: "new-refresh",
            expires_in: 3600,
          };
        },
      },
      async ({ credentials }) => {
        actions++;
        if (actions === 1)
          throw new ProviderError("invalid token", false, null, 30, true);
        return credentials.access_token;
      },
    );
    assert.equal(result, "new-access");
    assert.equal(actions, 2);
    assert.equal(refreshes, 1);
  } finally {
    f.db.close();
  }
});
