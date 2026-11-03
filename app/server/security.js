import {
  randomBytes,
  createHash,
  createCipheriv,
  createDecipheriv,
  timingSafeEqual,
} from "node:crypto";
import { AppError } from "./db.js";

export const token = () => randomBytes(32).toString("base64url");
export const hash = (value) => createHash("sha256").update(value).digest("hex");
export const isLoopbackOrigin = (origin) =>
  /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin || "");
export const isPilotOrigin = (origin) =>
  origin?.startsWith("https://") || isLoopbackOrigin(origin);
export function encryptionKey(configured, production) {
  if (configured) {
    const key = Buffer.from(configured, "base64");
    if (key.length === 32) return key;
    throw new Error("TOKEN_ENCRYPTION_KEY must contain 32 bytes in base64");
  }
  if (production)
    throw new Error("TOKEN_ENCRYPTION_KEY is required in production");
  return randomBytes(32); // No real provider tokens may be stored with this ephemeral key.
}
export function encrypt(value, key, context) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(context));
  const data = Buffer.concat([
    cipher.update(JSON.stringify(value), "utf8"),
    cipher.final(),
  ]);
  return [iv, cipher.getAuthTag(), data]
    .map((b) => b.toString("base64url"))
    .join(".");
}
export function decrypt(value, key, context) {
  const [iv, tag, data] = value
    .split(".")
    .map((v) => Buffer.from(v, "base64url"));
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(Buffer.from(context));
  decipher.setAuthTag(tag);
  return JSON.parse(
    Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8"),
  );
}
export function cookie(req, name) {
  const part = (req.headers.cookie || "")
    .split(";")
    .map((s) => s.trim())
    .find((s) => s.startsWith(name + "="));
  return part ? part.slice(name.length + 1) : "";
}
export function sessionCookie(res, value, production, clear = false) {
  res.cookie("ritm_session", value, {
    httpOnly: true,
    secure: production,
    sameSite: "lax",
    path: "/",
    maxAge: clear ? 0 : 7 * 86400000,
  });
}
export function sameOrigin(req, origin) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return;
  // JSON endpoints require a custom header as well as strict Origin checking.
  if (req.headers.origin !== origin || req.headers["x-ritm-request"] !== "1")
    throw new AppError(403, "Проверка источника запроса не пройдена.", "csrf");
}
export function secureEquals(a, b) {
  const aa = Buffer.from(a || ""),
    bb = Buffer.from(b || "");
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}
