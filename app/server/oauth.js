import { randomUUID, createHash } from "node:crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { AppError, transaction, requireBusiness } from "./db.js";
import {
  hash,
  token,
  cookie,
  encrypt,
  decrypt,
  sessionCookie,
} from "./security.js";
import {
  requestJson,
  DirectClient,
  ProviderError,
  refreshYandexToken,
} from "./providers.js";
const jwks = createRemoteJWKSet(
  new URL("https://www.googleapis.com/oauth2/v3/certs"),
);
const YANDEX_REDIRECT_URI = "https://oauth.yandex.ru/verification_code";
const REFRESH_AHEAD_MS = 5 * 60 * 1000;
const refreshLocks = new WeakMap();

function prepareYandexCredentials(data, previous = {}, now = Date.now()) {
  if (!data?.access_token)
    throw new ProviderError("Яндекс не вернул OAuth-токен.");
  const seconds = Number(data.expires_in);
  return {
    ...previous,
    ...data,
    refresh_token: data.refresh_token || previous.refresh_token || null,
    obtained_at: now,
    expires_at:
      Number.isFinite(seconds) && seconds > 0
        ? Math.min(now + Math.floor(seconds * 1000), 8.64e15)
        : null,
  };
}

function loadYandexConnection(db, key, businessId) {
  const row = db
    .prepare(
      "SELECT * FROM connections WHERE business_id=? AND provider='yandex'",
    )
    .get(businessId);
  if (!row) throw new AppError(409, "Подключите Яндекс.");
  return {
    row,
    metadata: JSON.parse(row.metadata),
    credentials: decrypt(row.encrypted, key, businessId + ":yandex"),
  };
}

function lockMap(db) {
  let map = refreshLocks.get(db);
  if (!map) {
    map = new Map();
    refreshLocks.set(db, map);
  }
  return map;
}

function credentialExpiry(credentials, metadata) {
  if (Number.isFinite(credentials.expires_at)) return credentials.expires_at;
  const seconds = Number(credentials.expires_in),
    connectedAt = Date.parse(metadata.connectedAt || "");
  return Number.isFinite(seconds) && seconds > 0 && Number.isFinite(connectedAt)
    ? Math.min(connectedAt + Math.floor(seconds * 1000), 8.64e15)
    : null;
}

export async function refreshYandexConnection({
  db,
  config,
  key,
  businessId,
  force = false,
  now = Date.now(),
  refreshToken = refreshYandexToken,
}) {
  const current = loadYandexConnection(db, key, businessId);
  const currentExpiry = credentialExpiry(
      current.credentials,
      current.metadata,
    ),
    due = currentExpiry !== null && currentExpiry <= now + REFRESH_AHEAD_MS;
  if (!force && !due) return { ...current, refreshed: false };
  const locks = lockMap(db);
  if (locks.has(businessId)) return locks.get(businessId);
  const pending = (async () => {
    const latest = loadYandexConnection(db, key, businessId);
    const latestExpiry = credentialExpiry(
        latest.credentials,
        latest.metadata,
      ),
      latestDue = latestExpiry !== null && latestExpiry <= now + REFRESH_AHEAD_MS;
    if (!force && !latestDue) return { ...latest, refreshed: false };
    if (!latest.credentials.refresh_token) {
      const metadata = {
        ...latest.metadata,
        validation: "reauth_required",
        validationMessage:
          "Срок доступа закончился. Подключите Яндекс заново.",
      };
      db.prepare(
        "UPDATE connections SET metadata=? WHERE business_id=? AND provider='yandex' AND encrypted=?",
      ).run(JSON.stringify(metadata), businessId, latest.row.encrypted);
      throw new AppError(
        409,
        "Срок доступа к Яндексу закончился. Подключите кабинет заново.",
        "reauth_required",
      );
    }
    let data;
    try {
      data = await refreshToken(
        latest.credentials.refresh_token,
        config.yandexId,
        config.yandexSecret,
      );
    } catch (error) {
      if (!error?.retryable) {
        const metadata = {
          ...latest.metadata,
          validation: "reauth_required",
          validationMessage:
            "Не удалось продлить доступ. Подключите Яндекс заново.",
          refreshFailedAt: new Date(now).toISOString(),
        };
        db.prepare(
          "UPDATE connections SET metadata=? WHERE business_id=? AND provider='yandex' AND encrypted=?",
        ).run(JSON.stringify(metadata), businessId, latest.row.encrypted);
        throw new AppError(
          409,
          "Не удалось продлить доступ к Яндексу. Подключите кабинет заново.",
          "reauth_required",
        );
      }
      throw error;
    }
    const credentials = prepareYandexCredentials(
      data,
      latest.credentials,
      now,
    );
    const encrypted = encrypt(credentials, key, businessId + ":yandex");
    const metadata = {
      ...latest.metadata,
      validation:
        latest.metadata.validation === "reauth_required"
          ? "verified"
          : latest.metadata.validation,
      validationMessage: null,
      tokenRefreshedAt: new Date(now).toISOString(),
      tokenExpiresAt: credentials.expires_at
        ? new Date(credentials.expires_at).toISOString()
        : null,
    };
    const result = db
      .prepare(
        "UPDATE connections SET encrypted=?,metadata=? WHERE business_id=? AND provider='yandex' AND encrypted=?",
      )
      .run(
        encrypted,
        JSON.stringify(metadata),
        businessId,
        latest.row.encrypted,
      );
    if (!result.changes)
      return { ...loadYandexConnection(db, key, businessId), refreshed: false };
    return {
      row: { ...latest.row, encrypted, metadata: JSON.stringify(metadata) },
      credentials,
      metadata,
      refreshed: true,
    };
  })().finally(() => locks.delete(businessId));
  locks.set(businessId, pending);
  return pending;
}

export async function withYandexConnection(options, action) {
  let connection = await refreshYandexConnection(options);
  try {
    return await action(connection);
  } catch (error) {
    if (!error?.authFailure) throw error;
    connection = await refreshYandexConnection({ ...options, force: true });
    return action(connection);
  }
}

function redirectUri(provider, config) {
  return provider === "yandex"
    ? YANDEX_REDIRECT_URI
    : `${config.origin}/auth/google/callback`;
}

async function exchangeCode(provider, code, saved, config) {
  const params = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: provider === "google" ? config.googleId : config.yandexId,
    client_secret:
      provider === "google" ? config.googleSecret : config.yandexSecret,
    redirect_uri: redirectUri(provider, config),
  });
  if (provider === "google") params.set("code_verifier", saved.verifier);
  else {
    params.set("device_id", saved.verifier);
    params.set("device_name", "Ритм · рекламный кабинет");
  }
  return requestJson(
    provider === "google"
      ? "https://oauth2.googleapis.com/token"
      : "https://oauth.yandex.ru/token",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
      timeoutMs: 45000,
    },
  );
}

export async function connectYandex({
  db,
  config,
  key,
  business,
  data,
  directFactory = (options) => new DirectClient(options),
}) {
  const previous = db
    .prepare(
      "SELECT encrypted,metadata FROM connections WHERE business_id=? AND provider='yandex'",
    )
    .get(business.id);
  const credentials = prepareYandexCredentials(data);
  const encrypted = encrypt(credentials, key, business.id + ":yandex");
  let metadata = {
    connectionId: randomUUID(),
    connectedAt: new Date().toISOString(),
    clients: [],
    sandbox: config.sandbox,
    validation: "pending",
    validationMessage: "Токен сохранен. Проверяем доступ к Директу.",
    tokenExpiresAt: credentials.expires_at
      ? new Date(credentials.expires_at).toISOString()
      : null,
  };
  const save = db.prepare(
    "INSERT INTO connections VALUES(?,?,?,?) ON CONFLICT(business_id,provider) DO UPDATE SET encrypted=excluded.encrypted,metadata=excluded.metadata",
  );
  save.run(business.id, "yandex", encrypted, JSON.stringify(metadata));
  const direct = directFactory({
    accessToken: credentials.access_token,
    sandbox: config.sandbox,
  });
  try {
    const result = await direct.clients();
    metadata = {
      ...metadata,
      clients: result.Clients || [],
      validation: "verified",
      validationMessage: null,
      validatedAt: new Date().toISOString(),
    };
    save.run(business.id, "yandex", encrypted, JSON.stringify(metadata));
  } catch (error) {
    if (!error?.retryable) {
      if (previous)
        save.run(business.id, "yandex", previous.encrypted, previous.metadata);
      else
        db.prepare(
          "DELETE FROM connections WHERE business_id=? AND provider='yandex'",
        ).run(business.id);
      throw error;
    }
    metadata = {
      ...metadata,
      validationMessage:
        "Токен сохранен. Директ пока не ответил — повторите проверку кабинета.",
    };
    save.run(business.id, "yandex", encrypted, JSON.stringify(metadata));
  }
  return metadata;
}

export function installOAuth(
  app,
  {
    db,
    config,
    key,
    auth,
    directFactory,
    exchange = exchangeCode,
    verifyGoogle = (idToken, audience) =>
      jwtVerify(idToken, jwks, {
        issuer: ["https://accounts.google.com", "accounts.google.com"],
        audience,
      }),
  },
) {
  app.get("/auth/:provider/start", async (req, res) => {
    const provider = req.params.provider;
    if (!["google", "yandex"].includes(provider))
      throw new AppError(404, "Провайдер не найден.");
    if (provider === "yandex" && !auth(req))
      throw new AppError(401, "Сначала войдите через Google.");
    const clientId = provider === "google" ? config.googleId : config.yandexId;
    const secret =
      provider === "google" ? config.googleSecret : config.yandexSecret;
    if (!clientId || !secret)
      throw new AppError(
        503,
        "OAuth еще не настроен. Заполните параметры приложения на сервере.",
        "not_configured",
      );
    if (provider === "yandex" && !config.encryptionConfigured)
      throw new AppError(
        503,
        "Сначала настройте постоянный ключ шифрования токенов.",
      );
    let businessId = null;
    if (provider === "yandex") {
      const business = requireBusiness(db, auth(req).id, req.query.businessId);
      businessId = business.id;
      if (business.state.mode === "demo")
        throw new AppError(
          409,
          "К демонстрационному бизнесу нельзя подключить реальный кабинет. Создайте бизнес после входа через Google.",
        );
    }
    const state = token(),
      verifier = token(),
      binding = token(),
      user = auth(req);
    if (provider === "yandex")
      db.prepare(
        "DELETE FROM oauth_states WHERE provider='yandex' AND user_id=? AND business_id=?",
      ).run(user.id, businessId);
    db.prepare("INSERT INTO oauth_states VALUES(?,?,?,?,?,?,?)").run(
      hash(state),
      provider,
      hash(binding),
      user?.id || null,
      verifier,
      Date.now() + 600000,
      businessId,
    );
    res.cookie("ritm_oauth", binding, {
      httpOnly: true,
      sameSite: "lax",
      secure: config.production,
      path: provider === "yandex" ? "/" : "/auth",
      maxAge: 600000,
    });
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri(provider, config),
      response_type: "code",
      state,
    });
    if (provider === "google") {
      params.set("scope", "openid email profile");
      // Always show Google's account chooser after a local sign-out. Otherwise
      // the browser silently signs the person back into the previous account.
      params.set("prompt", "select_account");
      params.set("nonce", state);
      params.set("code_challenge_method", "S256");
      params.set(
        "code_challenge",
        createHash("sha256").update(verifier).digest("base64url"),
      );
    } else {
      params.set("device_id", verifier);
      params.set("device_name", "Ритм · рекламный кабинет");
    }
    res.redirect(
      (provider === "google"
        ? "https://accounts.google.com/o/oauth2/v2/auth?"
        : "https://oauth.yandex.ru/authorize?") + params,
    );
  });
  app.get("/auth/:provider/callback", async (req, res) => {
    const { provider } = req.params,
      state = String(req.query.state || ""),
      code = String(req.query.code || "");
    if (!code || !state)
      throw new AppError(400, "Авторизация отменена или не завершена.");
    const saved = transaction(db, () => {
      const saved = db
        .prepare("SELECT * FROM oauth_states WHERE hash=? AND provider=?")
        .get(hash(state), provider);
      if (
        !saved ||
        saved.expires_at < Date.now() ||
        saved.session_hash !== hash(cookie(req, "ritm_oauth"))
      )
        throw new AppError(
          400,
          "Ссылка входа устарела. Начните подключение заново.",
        );
      db.prepare("DELETE FROM oauth_states WHERE hash=?").run(hash(state));
      return saved;
    });
    const data = await exchange(provider, code, saved, config);
    if (provider === "google") {
      let payload;
      try {
        ({ payload } = await verifyGoogle(data.id_token, config.googleId));
      } catch (error) {
        // An expired Google ID token is never accepted. It can happen when
        // the local clock is wrong or an old callback is resumed. Return the
        // user to the application instead of exposing a jose implementation
        // code in the browser.
        if (error?.code === "ERR_JWT_EXPIRED" || error?.name === "JWTExpired") {
          res.clearCookie("ritm_oauth", { path: "/auth" });
          return res.redirect("/?authError=google-token-expired");
        }
        throw error;
      }
      if (
        payload.nonce !== state ||
        !payload.sub ||
        payload.email_verified !== true
      )
        throw new AppError(401, "Не удалось проверить аккаунт Google.");
      let user = db
        .prepare("SELECT * FROM users WHERE subject=?")
        .get("google:" + payload.sub);
      if (!user) {
        user = {
          id: randomUUID(),
          name:
            typeof payload.name === "string"
              ? payload.name
              : "Владелец бизнеса",
        };
        db.prepare("INSERT INTO users VALUES(?,?,?,?)").run(
          user.id,
          "google:" + payload.sub,
          user.name,
          new Date().toISOString(),
        );
      }
      const session = token();
      db.prepare("INSERT INTO sessions VALUES(?,?,?)").run(
        hash(session),
        user.id,
        Date.now() + 7 * 86400000,
      );
      sessionCookie(res, session, config.production);
    } else {
      const user = auth(req);
      if (!user || saved.user_id !== user.id)
        throw new AppError(401, "Сеанс изменился. Подключите кабинет заново.");
      const business = requireBusiness(db, user.id, saved.business_id);
      await connectYandex({
        db,
        config,
        key,
        business,
        data,
        directFactory,
      });
    }
    res.clearCookie("ritm_oauth", {
      path: provider === "yandex" ? "/" : "/auth",
    });
    res.redirect("/?connected=" + provider);
  });
  app.post(
    "/api/businesses/:businessId/yandex/oauth/complete",
    async (req, res) => {
      const user = auth(req);
      if (!user)
        throw new AppError(401, "Войдите в свой аккаунт.", "unauthorized");
      if (!config.yandexId || !config.yandexSecret)
        throw new AppError(
          503,
          "OAuth Яндекса еще не настроен.",
          "not_configured",
        );
      if (!config.encryptionConfigured)
        throw new AppError(
          503,
          "Сначала настройте постоянный ключ шифрования токенов.",
        );
      const code =
        typeof req.body?.code === "string" ? req.body.code.trim() : "";
      if (!/^[A-Za-z0-9_-]{4,2048}$/.test(code))
        throw new AppError(
          400,
          "Вставьте код подтверждения, показанный Яндексом.",
        );
      const business = requireBusiness(db, user.id, req.params.businessId);
      if (business.state.mode === "demo")
        throw new AppError(
          409,
          "К демонстрационному бизнесу нельзя подключить реальный кабинет.",
        );
      const binding = cookie(req, "ritm_oauth");
      const saved = db
        .prepare(
          "SELECT * FROM oauth_states WHERE provider='yandex' AND user_id=? AND business_id=? AND session_hash=? AND expires_at>? ORDER BY expires_at DESC LIMIT 1",
        )
        .get(user.id, business.id, hash(binding), Date.now());
      if (!saved)
        throw new AppError(
          400,
          "Код подключения устарел. Сначала снова откройте Яндекс.",
        );
      const data = await exchangeCode("yandex", code, saved, config);
      await connectYandex({
        db,
        config,
        key,
        business,
        data,
        directFactory,
      });
      db.prepare("DELETE FROM oauth_states WHERE hash=?").run(saved.hash);
      res.clearCookie("ritm_oauth", { path: "/" });
      res.json({ ok: true });
    },
  );
}
