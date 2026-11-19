import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";

/** Derive a 32-byte key from whatever string the operator supplied. */
export function deriveKey(secret: string): Buffer {
  return createHash("sha256").update(secret, "utf8").digest();
}

/** AES-256-GCM. Output layout: 12-byte IV | 16-byte tag | ciphertext. */
export function encrypt(key: Buffer, plaintext: string): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]);
}

export function decrypt(key: Buffer, blob: Buffer): string {
  const iv = blob.subarray(0, 12);
  const tag = blob.subarray(12, 28);
  const body = blob.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
}

export function safeEqual(a: string, b: string): boolean {
  const ab = createHash("sha256").update(a).digest();
  const bb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ab, bb);
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  return `scrypt$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, saltB64, hashB64] = stored.split("$");
  if (scheme !== "scrypt" || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, "base64");
  const actual = scryptSync(password, Buffer.from(saltB64, "base64"), expected.length);
  return timingSafeEqual(actual, expected);
}

/**
 * The key admin sessions are signed with: derived from the master key and the
 * admin password's hash, so setting a new password (change or reset) signs
 * out every session made with the old one.
 */
export function sessionKey(masterKey: Buffer, passwordHash: string | undefined): Buffer {
  return createHmac("sha256", masterKey).update(`admin-session:${passwordHash ?? ""}`).digest();
}

/** Stateless admin session: "<expiryMs>.<hmac>". Works across instances. */
export function signSession(key: Buffer, ttlMs: number, now = Date.now()): string {
  const exp = String(now + ttlMs);
  const sig = createHmac("sha256", key).update(`session:${exp}`).digest("base64url");
  return `${exp}.${sig}`;
}

export function verifySession(key: Buffer, token: string | undefined, now = Date.now()): boolean {
  if (!token) return false;
  const [exp, sig] = token.split(".");
  if (!exp || !sig || !/^\d+$/.test(exp) || Number(exp) < now) return false;
  const expected = createHmac("sha256", key).update(`session:${exp}`).digest("base64url");
  return safeEqual(sig, expected);
}

export function randomToken(bytes = 24): string {
  return randomBytes(bytes).toString("base64url");
}
