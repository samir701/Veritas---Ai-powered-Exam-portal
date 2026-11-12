import crypto from "node:crypto";

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_DKLEN = 32;
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function newId(prefix = "") {
  const raw = crypto.randomBytes(12).toString("hex");
  return prefix ? `${prefix}_${raw}` : raw;
}

export function generateToken(nbytes = 32) {
  return crypto.randomBytes(nbytes).toString("base64url");
}

export function hashToken(token) {
  return crypto.createHash("sha256").update(String(token), "utf8").digest("hex");
}

export function hashPassword(password) {
  if (typeof password !== "string" || password.length < 8) {
    throw new Error("Password must be at least 8 characters long.");
  }
  const salt = crypto.randomBytes(16);
  const digest = crypto.scryptSync(password, salt, SCRYPT_DKLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString("base64")}$${digest.toString("base64")}`;
}

export function verifyPassword(password, storedHash) {
  try {
    const parts = String(storedHash).split("$");
    if (parts.length !== 6 || parts[0] !== "scrypt") return false;
    const [, nS, rS, pS, saltB64, digestB64] = parts;
    const salt = Buffer.from(saltB64, "base64");
    const expected = Buffer.from(digestB64, "base64");
    const actual = crypto.scryptSync(String(password), salt, expected.length, {
      N: Number(nS),
      r: Number(rS),
      p: Number(pS),
    });
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

function base32Decode(str) {
  const clean = String(str).toUpperCase().replace(/=+$/, "").replace(/\s+/g, "");
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error("Invalid Base32 character");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

export function generateMfaSecret() {
  return base32Encode(crypto.randomBytes(20));
}

export function totpUri(secret, email, issuer = "VeritasExamPortal") {
  const label = encodeURIComponent(`${issuer}:${email}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

function hotp(secret, counter) {
  const key = base32Decode(secret);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const digest = crypto.createHmac("sha1", key).update(msg).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const codeInt =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);
  return String(codeInt % 1_000_000).padStart(6, "0");
}

export function currentTotp(secret, atTime = null) {
  const ts = atTime === null ? Math.floor(Date.now() / 1000) : atTime;
  return hotp(secret, Math.floor(ts / 30));
}

export function verifyTotp(secret, code, atTime = null, window = 1) {
  const cleaned = String(code || "").replace(/\D+/g, "");
  if (cleaned.length !== 6) return false;
  const ts = atTime === null ? Math.floor(Date.now() / 1000) : atTime;
  const step = Math.floor(ts / 30);
  const codeBuf = Buffer.from(cleaned, "utf8");
  for (let delta = -window; delta <= window; delta += 1) {
    const candidateBuf = Buffer.from(hotp(secret, step + delta), "utf8");
    if (crypto.timingSafeEqual(candidateBuf, codeBuf)) {
      return true;
    }
  }
  return false;
}

export function signValue(secretKey, value) {
  const sig = crypto.createHmac("sha256", secretKey).update(value, "utf8").digest("hex");
  return `${value}.${sig}`;
}

export function verifySignedValue(secretKey, signed) {
  if (typeof signed !== "string" || !signed.includes(".")) return null;
  const idx = signed.lastIndexOf(".");
  const value = signed.slice(0, idx);
  const sig = signed.slice(idx + 1);
  const expected = crypto.createHmac("sha256", secretKey).update(value, "utf8").digest("hex");
  const sigBuf = Buffer.from(sig, "utf8");
  const expBuf = Buffer.from(expected, "utf8");
  if (sigBuf.length === expBuf.length && crypto.timingSafeEqual(sigBuf, expBuf)) {
    return value;
  }
  return null;
}

export class RateLimiter {
  constructor() {
    this.buckets = new Map();
  }

  allow(key, limit, windowSeconds = 60) {
    const now = Date.now() / 1000;
    const cutoff = now - windowSeconds;
    let queue = this.buckets.get(key);
    if (!queue) {
      queue = [];
      this.buckets.set(key, queue);
    }
    while (queue.length > 0 && queue[0] <= cutoff) {
      queue.shift();
    }
    if (queue.length >= limit) {
      const retryAfter = Math.max(1, Math.ceil(queue[0] + windowSeconds - now));
      return { allowed: false, retryAfter };
    }
    queue.push(now);
    return { allowed: true, retryAfter: 0 };
  }
}

