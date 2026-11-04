/**
 * A small OAuth 2.1 authorization server, so Claude can connect without a
 * secret in the URL. Sign-in is delegated to Google; only emails listed in
 * ACCOUNT_EMAIL get a token.
 *
 * Flow, as the MCP authorization spec describes it:
 *   1. /api/mcp without a token answers 401, pointing at the resource metadata.
 *   2. Claude reads the metadata and registers itself (/oauth/register).
 *   3. /oauth/authorize sends the browser to Google; Google comes back to
 *      /oauth/google/callback, which checks the email and returns a code to Claude.
 *   4. Claude swaps the code (with its PKCE verifier) for tokens at /oauth/token.
 *
 * It is stateless: every id, code and token is HMAC-signed with
 * OAUTH_SIGNING_SECRET (see tokens.js). The cost is that a single token can't be
 * revoked; changing OAUTH_SIGNING_SECRET signs everyone out at once.
 */
import { createHash, randomBytes } from "node:crypto";
import { MCP_PATH, env, isAllowed } from "./account.js";
import { now, sign, verify } from "./tokens.js";

const MIN_SECRET_LENGTH = 24;
const ACCESS_TTL = 60 * 60;
const REFRESH_TTL = 30 * 24 * 60 * 60;
const LOGIN_TTL = 10 * 60;
const CODE_TTL = 5 * 60;
const COOKIE = "gc_login";
const GOOGLE_AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";

/** `{ enabled: false }` when OAuth isn't set up, `{ error }` when it's half set up. */
export function oauthConfig() {
  const clientId = env("GOOGLE_CLIENT_ID");
  const clientSecret = env("GOOGLE_CLIENT_SECRET");
  const signingSecret = env("OAUTH_SIGNING_SECRET");
  if (!clientId && !clientSecret && !signingSecret) return { enabled: false };
  if (!clientId || !clientSecret) return { error: "GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must both be set." };
  if (!signingSecret || signingSecret.length < MIN_SECRET_LENGTH) {
    return { error: `OAUTH_SIGNING_SECRET is not set or is shorter than ${MIN_SECRET_LENGTH} characters.` };
  }
  return { enabled: true, clientId, clientSecret, signingSecret };
}

/** `{ email }` for a valid access token, else null. */
export function verifyAccessToken(config, token) {
  const payload = verify(config.signingSecret, token, "access");
  return payload ? { email: payload.e } : null;
}

/** Set PUBLIC_URL when a proxy sits in front (standalone.js); Vercel's request URL is already right. */
export const publicOrigin = (request) => env("PUBLIC_URL")?.replace(/\/+$/, "") ?? new URL(request.url).origin;

/** The 401 that tells Claude where to find the OAuth metadata. */
export function unauthorized(request, error) {
  const path = new URL(request.url).pathname.replace(/\/+$/, "");
  const metadata = `${publicOrigin(request)}/.well-known/oauth-protected-resource${path}`;
  const challenge = `Bearer resource_metadata="${metadata}"${error ? `, error="${error}"` : ""}`;
  return new Response("Unauthorized", { status: 401, headers: { "www-authenticate": challenge, ...CORS } });
}

export async function handleOAuth(request) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const config = oauthConfig();
  if (config.error) return text(config.error, 503);
  if (!config.enabled) return text("Not found", 404);

  const url = new URL(request.url);
  const origin = publicOrigin(request);
  const prm = "/.well-known/oauth-protected-resource";
  if (request.method === "GET" && url.pathname.startsWith(prm)) {
    // Bare, or suffixed with the connector path (RFC 9728): .../oauth-protected-resource/api/mcp.
    const path = url.pathname.slice(prm.length) || "/api/mcp";
    if (!MCP_PATH.test(path)) return text("Not found", 404);
    return json({ resource: `${origin}${path.replace(/\/+$/, "")}`, authorization_servers: [origin], bearer_methods_supported: ["header"] });
  }
  try {
    switch (`${request.method} ${url.pathname}`) {
      case "GET /.well-known/oauth-authorization-server":
        return json({
          issuer: origin,
          authorization_endpoint: `${origin}/oauth/authorize`,
          token_endpoint: `${origin}/oauth/token`,
          registration_endpoint: `${origin}/oauth/register`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
          authorization_response_iss_parameter_supported: true,
        });
      case "POST /oauth/register":
        return await register(config, request);
      case "GET /oauth/authorize":
        return authorize(config, url, origin);
      case "GET /oauth/google/callback":
        return await googleCallback(config, request, url, origin);
      case "POST /oauth/token":
        return await token(config, request);
      default:
        return text("Not found", 404);
    }
  } catch (err) {
    console.error(err);
    return text("Internal error", 500);
  }
}

/** Dynamic client registration. The client id is just the signed list of redirect URIs. */
async function register(config, request) {
  const body = await request.json().catch(() => null);
  const uris = body?.redirect_uris;
  if (!Array.isArray(uris) || !uris.length || !uris.every(allowedRedirect)) {
    return oauthError("invalid_redirect_uri", "Only Claude's callback URLs are accepted.");
  }
  return json(
    {
      client_id: sign(config.signingSecret, { t: "client", r: uris }),
      client_id_issued_at: now(),
      client_name: typeof body.client_name === "string" ? body.client_name : undefined,
      redirect_uris: uris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    },
    201,
  );
}

/**
 * Redirects are limited to Claude's own callbacks (plus localhost for Claude
 * Code), so nobody can register a client that sends codes to their own site.
 */
function allowedRedirect(uri) {
  let u;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (u.hash || u.username || u.password) return false;
  if (u.protocol === "https:") return u.hostname === "claude.ai" || u.hostname === "claude.com";
  return u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1");
}

function authorize(config, url, origin) {
  const p = Object.fromEntries(url.searchParams);
  const client = verify(config.signingSecret, p.client_id, "client");
  if (!client) return page("This connector's registration isn't valid. Remove the connector in Claude and add it again.", 400);
  const redirectUri = p.redirect_uri ?? (client.r.length === 1 ? client.r[0] : undefined);
  if (!redirectUri || !client.r.includes(redirectUri)) return page("The redirect URL doesn't match this connector.", 400);

  // The redirect URI is trusted from here on, so errors go back to Claude.
  const fail = (error, description) =>
    redirect(withParams(redirectUri, { error, error_description: description, state: p.state, iss: origin }));
  if (p.response_type !== "code") return fail("unsupported_response_type", "Only response_type=code is supported.");
  if (!p.code_challenge || p.code_challenge_method !== "S256") return fail("invalid_request", "PKCE with S256 is required.");
  if (!isOurResource(p.resource, origin)) return fail("invalid_target", "Unknown resource.");

  // The nonce ties Google's callback to this browser, so a sign-in can't be finished from a link someone sent you.
  const nonce = randomBytes(16).toString("base64url");
  const state = sign(config.signingSecret, {
    t: "login",
    n: nonce,
    c: p.client_id,
    r: redirectUri,
    s: p.state,
    ch: p.code_challenge,
    exp: now() + LOGIN_TTL,
  });
  const google = withParams(GOOGLE_AUTH, {
    client_id: config.clientId,
    redirect_uri: `${origin}/oauth/google/callback`,
    response_type: "code",
    scope: "openid email",
    state,
    prompt: "select_account",
  });
  return redirect(google, `${COOKIE}=${nonce}; Path=/oauth; Max-Age=${LOGIN_TTL}; HttpOnly; Secure; SameSite=Lax`);
}

async function googleCallback(config, request, url, origin) {
  const login = verify(config.signingSecret, url.searchParams.get("state"), "login");
  if (!login) return page("This sign-in link has expired. Start again from Claude.", 400);
  if (readCookie(request, COOKIE) !== login.n) {
    return page("Sign-in has to finish in the same browser it started in. Start again from Claude.", 400);
  }
  const clearCookie = `${COOKIE}=; Path=/oauth; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
  const back = (params) => redirect(withParams(login.r, { ...params, state: login.s, iss: origin }), clearCookie);

  if (url.searchParams.get("error")) return back({ error: "access_denied", error_description: "Google sign-in was cancelled." });
  const email = await googleEmail(config, url.searchParams.get("code"), origin);
  if (!email) return page("Google sign-in didn't work. Start again from Claude.", 502);
  if (!isAllowed(email)) return page(`${email} isn't allowed to use this connector.`, 403);

  const code = sign(config.signingSecret, {
    t: "code",
    e: email,
    c: login.c,
    r: login.r,
    ch: login.ch,
    exp: now() + CODE_TTL,
  });
  return back({ code });
}

/** Swaps Google's code for an ID token and returns its verified email, lowercased. */
async function googleEmail(config, code, origin) {
  if (!code) return null;
  const res = await fetch(GOOGLE_TOKEN, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: `${origin}/oauth/google/callback`,
      grant_type: "authorization_code",
    }),
  });
  if (!res.ok) {
    console.error(`Google token exchange failed (${res.status}): ${await res.text()}`);
    return null;
  }
  const { id_token: idToken } = await res.json();
  // The token came straight from Google over TLS, so Google's docs allow skipping the signature check.
  let claims;
  try {
    claims = JSON.parse(Buffer.from(String(idToken).split(".")[1], "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (claims.aud !== config.clientId || claims.email_verified !== true || typeof claims.email !== "string") return null;
  return claims.email.toLowerCase();
}

async function token(config, request) {
  const form = new URLSearchParams(await request.text());
  let email, clientId;
  if (form.get("grant_type") === "authorization_code") {
    const code = verify(config.signingSecret, form.get("code"), "code");
    if (!code) return oauthError("invalid_grant", "The code is invalid or has expired.");
    if (form.has("client_id") && form.get("client_id") !== code.c) return oauthError("invalid_grant", "The code was issued to another client.");
    if (form.has("redirect_uri") && form.get("redirect_uri") !== code.r) return oauthError("invalid_grant", "redirect_uri doesn't match.");
    const verifier = form.get("code_verifier") ?? "";
    if (createHash("sha256").update(verifier).digest("base64url") !== code.ch) {
      return oauthError("invalid_grant", "PKCE verification failed.");
    }
    ({ e: email, c: clientId } = code);
  } else if (form.get("grant_type") === "refresh_token") {
    const refresh = verify(config.signingSecret, form.get("refresh_token"), "refresh");
    if (!refresh) return oauthError("invalid_grant", "The refresh token is invalid or has expired.");
    ({ e: email, c: clientId } = refresh);
  } else {
    return oauthError("unsupported_grant_type", "Use authorization_code or refresh_token.");
  }

  // Checked again on every refresh, so removing an email from the allowlist cuts that person off within the hour.
  if (!isAllowed(email)) return oauthError("invalid_grant", "This account is no longer allowed.");
  return json(
    {
      access_token: sign(config.signingSecret, { t: "access", e: email, exp: now() + ACCESS_TTL }),
      token_type: "Bearer",
      expires_in: ACCESS_TTL,
      refresh_token: sign(config.signingSecret, { t: "refresh", e: email, c: clientId, exp: now() + REFRESH_TTL }),
    },
    200,
    { "cache-control": "no-store" },
  );
}

/** True when Claude asks for no resource or for this connector's own URL. */
function isOurResource(resource, origin) {
  if (!resource) return true;
  let u;
  try {
    u = new URL(resource);
  } catch {
    return false;
  }
  return u.origin === origin && MCP_PATH.test(u.pathname);
}

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
  "access-control-allow-headers": "authorization, content-type, mcp-protocol-version",
  "access-control-expose-headers": "www-authenticate",
};

const text = (body, status) =>
  new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8", ...CORS } });

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...CORS, ...headers } });

const oauthError = (error, description) => json({ error, error_description: description }, 400, { "cache-control": "no-store" });

function redirect(location, cookie) {
  const headers = { location, "cache-control": "no-store" };
  if (cookie) headers["set-cookie"] = cookie;
  return new Response(null, { status: 302, headers });
}

function withParams(base, params) {
  const url = new URL(base);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, v);
  return url.toString();
}

function readCookie(request, name) {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return undefined;
}

const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function page(message, status) {
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Garmin connector</title>
<body style="font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem">
<h1 style="font-size:1.25rem">Garmin connector</h1><p>${escapeHtml(message)}</p></body>`;
  return new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}
