import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export function makeSecret(prefix, bytes = 32) {
  return `${prefix}_${randomBytes(bytes).toString("base64url")}`;
}

export function hashSecret(secret, salt = randomBytes(16).toString("base64url")) {
  const hash = createHash("sha256").update(`${salt}:${secret}`).digest("base64url");
  return { salt, hash };
}

export function safeCompareHash(secret, salt, expectedHash) {
  const actual = hashSecret(secret, salt).hash;
  const left = Buffer.from(actual);
  const right = Buffer.from(expectedHash);

  if (left.length !== right.length) {
    return false;
  }

  return timingSafeEqual(left, right);
}

export function secretPrefix(secret) {
  if (!secret || secret.length < 16) {
    return "unknown";
  }

  return `${secret.slice(0, 14)}...${secret.slice(-4)}`;
}

export function redactSecret(secret) {
  if (!secret) {
    return null;
  }

  return {
    configured: true,
    prefix: secretPrefix(secret)
  };
}

