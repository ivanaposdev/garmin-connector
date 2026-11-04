/**
 * Signed, self-contained tokens: `<base64url JSON>.<base64url HMAC-SHA256>`.
 *
 * Everything the OAuth flow hands out (client ids, login state, codes, access
 * and refresh tokens) is one of these, so nothing has to be stored between
 * requests. The `t` field names the kind of token, so one kind can never be
 * passed off as another. They are signed, not encrypted: don't put secrets in them.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export const now = () => Math.floor(Date.now() / 1000);
const mac = (secret, body) => createHmac("sha256", secret).update(body).digest();

export function sign(secret, payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${mac(secret, body).toString("base64url")}`;
}

/** Returns the payload if the token is genuine, of the given kind and not expired; otherwise null. */
export function verify(secret, token, type) {
  const [body, signature, extra] = String(token ?? "").split(".");
  if (!body || !signature || extra !== undefined) return null;
  const given = Buffer.from(signature, "base64url");
  const expected = mac(secret, body);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (payload?.t !== type) return null;
  if (typeof payload.exp === "number" && payload.exp < now()) return null;
  return payload;
}
