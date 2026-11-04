/**
 * Front door for garmin-personal-mcp.
 *
 * claude.ai custom connectors take a URL (plus optional OAuth), but no custom
 * headers, while garmin-personal-mcp only accepts `Authorization: Bearer ...`.
 * This handler checks the caller, then forwards the request to garmin-personal-mcp
 * with a bearer token that never leaves this process.
 *
 * A request is accepted in one of two ways:
 *   - an OAuth access token from Google sign-in (see oauth.js) for an email
 *     listed in ACCOUNT_EMAIL. This is the recommended way;
 *   - a secret in the URL (`?key=<CONNECTOR_SECRET>`), only if that variable is set.
 *
 * A wrong `?key=` gets a plain 404 (not a 401), so nobody probing the URL learns
 * that anything lives here. With no credentials at all, the answer is a 401
 * pointing at the OAuth metadata when OAuth is set up, and a 404 otherwise.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createFetchHandler } from "garmin-personal-mcp/dist/http.js";
import { loadAccount } from "./account.js";
import { oauthConfig, unauthorized, verifyAccessToken } from "./oauth.js";

const internalToken = randomBytes(32).toString("hex");
let upstream;
let upstreamKey;

const digest = (value) => createHash("sha256").update(value).digest();
const text = (body, status) =>
  new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8" } });

export async function handle(request) {
  const { account, error } = loadAccount();
  if (error) return text(error, 503);

  const url = new URL(request.url);
  const bearer = request.headers.get("authorization")?.match(/^Bearer\s+(\S+)$/i)?.[1];
  if (bearer) {
    const oauth = oauthConfig();
    if (oauth.error) return text(oauth.error, 503);
    const token = oauth.enabled ? verifyAccessToken(oauth, bearer) : null;
    if (!token || !account.emails.includes(token.email)) return unauthorized(request, "invalid_token");
  } else if (url.searchParams.has("key")) {
    const ok = account.secret && timingSafeEqual(digest(url.searchParams.get("key")), digest(account.secret));
    if (!ok) return text("Not found", 404);
  } else {
    const oauth = oauthConfig();
    if (oauth.error) return text(oauth.error, 503);
    return oauth.enabled ? unauthorized(request) : text("Not found", 404);
  }

  // Rebuilt when the Garmin key changes in the environment.
  if (upstreamKey !== account.apiKey) {
    upstream = createFetchHandler({ bearerToken: internalToken, apiKey: account.apiKey });
    upstreamKey = account.apiKey;
  }

  const headers = new Headers(request.headers);
  headers.set("authorization", `Bearer ${internalToken}`);
  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  const forwarded = new Request(new URL("/mcp", url.origin), {
    method: request.method,
    headers,
    body: hasBody ? request.body : undefined,
    duplex: "half",
  });

  try {
    return await upstream(forwarded);
  } catch (err) {
    console.error(err);
    return text("Internal error", 500);
  }
}
