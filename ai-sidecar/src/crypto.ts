import crypto from "node:crypto";

const deriveKey = (secret: string) => crypto.createHash("sha256").update(secret).digest();

export function encryptSecret(value: string, secret: string): string {
  if (!secret) throw new Error("SESSION_SECRET is required before storing provider keys");
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", deriveKey(secret), iv);
  const body = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), body.toString("base64url")].join(".");
}

export function decryptSecret(token: string, secret: string): string {
  const [version, iv, tag, body] = token.split(".");
  if (version !== "v1" || !iv || !tag || !body || !secret) throw new Error("Unable to decrypt provider key");
  const decipher = crypto.createDecipheriv("aes-256-gcm", deriveKey(secret), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(body, "base64url")), decipher.final()]).toString("utf8");
}
