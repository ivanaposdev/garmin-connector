/**
 * The one Garmin account this deployment serves, read from the environment.
 *
 * Reached by Google sign-in (an email listed in ACCOUNT_EMAIL) and, optionally,
 * by a secret in the URL (`?key=<CONNECTOR_SECRET>`). Leave CONNECTOR_SECRET
 * unset to keep URL secrets off. Someone else's Garmin data needs its own deployment.
 */
const MIN_SECRET_LENGTH = 24;

/** The connector's path. */
export const MCP_PATH = /^\/api\/mcp\/?$/;

export const env = (name) => process.env[name]?.trim() || undefined;

/** Returns `{ account }`, or `{ error }` if the config is unusable. */
export function loadAccount() {
  const apiKey = env("GARMIN_PERSONAL_API_KEY");
  const secret = env("CONNECTOR_SECRET");
  // Comma-separated, so more than one Google account can sign in.
  const emails = (env("ACCOUNT_EMAIL") ?? "").toLowerCase().split(/[\s,]+/).filter(Boolean);
  if (!apiKey) return { error: "GARMIN_PERSONAL_API_KEY is not set." };
  if (!secret && !emails.length) return { error: "Set ACCOUNT_EMAIL (Google sign-in) or CONNECTOR_SECRET so the connector can be reached." };
  if (secret && secret.length < MIN_SECRET_LENGTH) {
    return { error: `CONNECTOR_SECRET is shorter than ${MIN_SECRET_LENGTH} characters.` };
  }
  return { account: { apiKey, secret, emails } };
}

/** Whether a signed-in Google email may use the connector. */
export function isAllowed(email) {
  const { account } = loadAccount();
  return Boolean(account?.emails.includes(email));
}
