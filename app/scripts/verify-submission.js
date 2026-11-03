import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MANIFEST = "SUBMISSION-MANIFEST.json";
const posix = (value) => value.split(path.sep).join("/");

async function defaultSubmissionRoot() {
  const current = process.cwd();
  if (await stat(path.join(current, MANIFEST)).catch(() => null)) return current;
  const output = path.join(current, "output");
  const entries = await readdir(output, { withFileTypes: true }).catch(() => []);
  const candidates = entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("ritm-test-submission-"))
    .map((entry) => path.join(output, entry.name))
    .sort()
    .reverse();
  for (const candidate of candidates)
    if (await stat(path.join(candidate, MANIFEST)).catch(() => null))
      return candidate;
  return current;
}

async function walk(root, relativeDirectory = "") {
  const entries = await readdir(path.join(root, relativeDirectory), {
    withFileTypes: true,
  });
  const files = [];
  for (const entry of entries) {
    const relativePath = path.join(relativeDirectory, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(root, relativePath)));
    else if (entry.isFile()) files.push(posix(relativePath));
  }
  return files;
}

export async function verifySubmission(root = process.cwd()) {
  const resolvedRoot = path.resolve(root);
  const manifestPath = path.join(resolvedRoot, MANIFEST);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (
    manifest.schema !== "ritm.submission.v1" ||
    !Array.isArray(manifest.files)
  )
    throw new Error("Unsupported or malformed submission manifest");

  const listed = new Set(manifest.files.map((file) => file.path));
  if (
    listed.size !== manifest.files.length ||
    manifest.fileCount !== listed.size
  )
    throw new Error(
      "Submission manifest contains duplicate or inconsistent entries",
    );

  let totalBytes = 0;
  for (const file of manifest.files) {
    const absolute = path.resolve(resolvedRoot, file.path);
    if (!absolute.startsWith(resolvedRoot + path.sep))
      throw new Error(`Unsafe manifest path: ${file.path}`);
    const metadata = await stat(absolute).catch(() => null);
    if (!metadata?.isFile())
      throw new Error(`Missing submission file: ${file.path}`);
    const content = await readFile(absolute);
    const sha256 = createHash("sha256").update(content).digest("hex");
    if (content.length !== file.bytes || sha256 !== file.sha256)
      throw new Error(`Submission file changed: ${file.path}`);
    totalBytes += content.length;
  }
  if (totalBytes !== manifest.totalBytes)
    throw new Error("Submission total size does not match the manifest");

  const actual = (await walk(resolvedRoot)).filter((file) => file !== MANIFEST);
  const extras = actual.filter((file) => !listed.has(file));
  if (extras.length)
    throw new Error(`Unexpected submission file: ${extras[0]}`);
  return { ok: true, fileCount: listed.size, totalBytes };
}

const invokedDirectly =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  try {
    const root = process.argv[2]
      ? path.resolve(process.argv[2])
      : await defaultSubmissionRoot();
    console.log(
      JSON.stringify({ root, ...(await verifySubmission(root)) }, null, 2),
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
