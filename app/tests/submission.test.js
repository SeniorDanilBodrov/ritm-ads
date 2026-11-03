import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  auditSubmissionFiles,
  submissionFiles,
} from "../scripts/prepare-submission.js";

test("submission inventory excludes local state and dependencies", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ritm-submission-"));
  try {
    await mkdir(path.join(root, "server"), { recursive: true });
    await mkdir(path.join(root, "docs"), { recursive: true });
    await mkdir(path.join(root, "server", "data"), { recursive: true });
    await mkdir(path.join(root, "docs", "tmp"), { recursive: true });
    await writeFile(path.join(root, "README.md"), "safe");
    await writeFile(path.join(root, "server", "index.js"), "export {};");
    await writeFile(
      path.join(root, "server", "data", "private.sqlite"),
      "private",
    );
    await writeFile(
      path.join(root, "docs", "tmp", "browser-cookie.txt"),
      "private",
    );
    const files = await submissionFiles(root);
    assert.deepEqual(files, ["README.md", path.join("server", "index.js")]);
    assert.deepEqual(await auditSubmissionFiles(root, files), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("submission audit reports a committed credential without returning its value", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ritm-submission-secret-"));
  try {
    await mkdir(path.join(root, "docs"), { recursive: true });
    const unsafeFixture = ["YANDEX_CLIENT", "SECRET=not-a-placeholder"].join(
      "_",
    );
    await writeFile(path.join(root, "docs", "bad.md"), unsafeFixture);
    assert.deepEqual(
      await auditSubmissionFiles(root, [path.join("docs", "bad.md")]),
      [{ path: "docs/bad.md", reason: "possible_secret" }],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
