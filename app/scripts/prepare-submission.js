import { createHash } from "node:crypto";
import {
  cp,
  mkdir,
  readFile,
  readdir,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_FILES = [
  ".dockerignore",
  ".env.example",
  ".gitignore",
  "compose.yaml",
  "DESIGN.md",
  "Dockerfile",
  "index.html",
  "package-lock.json",
  "package.json",
  "premium-audit.json",
  "premium-ui.json",
  "README.md",
  "tsconfig.json",
  "UX-CONTRACT.md",
  "vite.config.js",
];
const ROOT_DIRECTORIES = ["ai", "docs", "scripts", "server", "src", "tests"];
const FORBIDDEN_SEGMENTS = new Set([
  ".git",
  ".env",
  "data",
  "dist",
  "node_modules",
  "output",
  "tmp",
  "__pycache__",
  "coverage",
]);
const TEXT_EXTENSIONS = new Set([
  "",
  ".css",
  ".html",
  ".js",
  ".json",
  ".md",
  ".py",
  ".ts",
  ".tsx",
  ".yaml",
  ".yml",
]);
const SECRET_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /(?:GOOGLE_CLIENT_SECRET|YANDEX_CLIENT_SECRET|TOKEN_ENCRYPTION_KEY)\s*=\s*(?!\s*$|\s*<)[^\s#]+/m,
];

const posix = (value) => value.split(path.sep).join("/");

function isForbidden(relativePath) {
  return relativePath
    .split(/[\\/]/)
    .some(
      (segment) =>
        FORBIDDEN_SEGMENTS.has(segment) || segment.endsWith(".sqlite"),
    );
}

async function walk(root, relativeDirectory) {
  const directory = path.join(root, relativeDirectory);
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relativePath = path.join(relativeDirectory, entry.name);
    if (isForbidden(relativePath)) continue;
    if (entry.isDirectory()) files.push(...(await walk(root, relativePath)));
    else if (entry.isFile()) files.push(relativePath);
  }
  return files;
}

export async function submissionFiles(root) {
  const files = [];
  for (const filename of ROOT_FILES) {
    const absolute = path.join(root, filename);
    if ((await stat(absolute).catch(() => null))?.isFile())
      files.push(filename);
  }
  for (const directory of ROOT_DIRECTORIES) {
    if (
      (await stat(path.join(root, directory)).catch(() => null))?.isDirectory()
    )
      files.push(...(await walk(root, directory)));
  }
  return files.sort((a, b) => posix(a).localeCompare(posix(b), "en"));
}

export async function auditSubmissionFiles(root, files) {
  const findings = [];
  for (const relativePath of files) {
    if (isForbidden(relativePath)) {
      findings.push({ path: posix(relativePath), reason: "forbidden_path" });
      continue;
    }
    if (!TEXT_EXTENSIONS.has(path.extname(relativePath).toLowerCase()))
      continue;
    const content = await readFile(path.join(root, relativePath), "utf8");
    if (SECRET_PATTERNS.some((pattern) => pattern.test(content)))
      findings.push({ path: posix(relativePath), reason: "possible_secret" });
  }
  return findings;
}

export async function prepareSubmission({
  root = process.cwd(),
  destination = path.join(
    process.cwd(),
    "output",
    `ritm-test-submission-${new Date().toISOString().replace(/[:.]/g, "-")}`,
  ),
} = {}) {
  const resolvedRoot = path.resolve(root);
  const resolvedDestination = path.resolve(destination);
  const outputRoot = path.resolve(resolvedRoot, "output");
  if (!resolvedDestination.startsWith(outputRoot + path.sep))
    throw new Error(
      "Submission destination must be inside the output directory",
    );
  if (await stat(resolvedDestination).catch(() => null))
    throw new Error(
      `Submission destination already exists: ${resolvedDestination}`,
    );

  const files = await submissionFiles(resolvedRoot);
  const findings = await auditSubmissionFiles(resolvedRoot, files);
  if (findings.length)
    throw new Error(
      `Submission audit failed: ${findings.map((item) => `${item.path}:${item.reason}`).join(", ")}`,
    );

  await mkdir(resolvedDestination, { recursive: true });
  const manifestFiles = [];
  for (const relativePath of files) {
    const source = path.join(resolvedRoot, relativePath);
    const target = path.join(resolvedDestination, relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    await cp(source, target, { force: false });
    const content = await readFile(source);
    manifestFiles.push({
      path: posix(relativePath),
      bytes: content.length,
      sha256: createHash("sha256").update(content).digest("hex"),
    });
  }

  const manifest = {
    schema: "ritm.submission.v1",
    generatedAt: new Date().toISOString(),
    fileCount: manifestFiles.length,
    totalBytes: manifestFiles.reduce((sum, file) => sum + file.bytes, 0),
    safety: {
      secretsIncluded: false,
      localDatabaseIncluded: false,
      browserProfilesIncluded: false,
      dependenciesIncluded: false,
    },
    files: manifestFiles,
  };
  await writeFile(
    path.join(resolvedDestination, "SUBMISSION-MANIFEST.json"),
    JSON.stringify(manifest, null, 2) + "\n",
    { flag: "wx" },
  );
  return { destination: resolvedDestination, ...manifest };
}

const invokedDirectly =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  try {
    const result = await prepareSubmission();
    console.log(
      JSON.stringify(
        {
          ok: true,
          destination: result.destination,
          fileCount: result.fileCount,
          totalBytes: result.totalBytes,
          safety: result.safety,
        },
        null,
        2,
      ),
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
