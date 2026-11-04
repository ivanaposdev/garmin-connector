# Garmin → Claude chat connector

Lets you ask Claude about your own Garmin data from any chat, on web, desktop or phone, through a claude.ai **custom connector**.

It's a thin wrapper around [garmin-personal-mcp](https://github.com/Shape-Calendar/garmin-personal-mcp) (MIT, pinned at 0.1.1), which uses Garmin's official Personal API. That server only accepts its secret as an `Authorization` header, and claude.ai's connector form can't send headers. This wrapper adds the login Claude can use: **OAuth, with sign-in delegated to Google**. Only the Google emails you allow get in, and Claude holds short-lived tokens, so nothing secret sits in the connector URL:

```
https://<your-app>.vercel.app/api/mcp
```

One deployment serves **one** Garmin account. Access is read-only, so nothing can be written to your Garmin account.

---

## 1. Create a Garmin Personal API key

Go to Garmin Connect on the **web** → Settings → **Personal API Key** → **Create Key**, or open
https://connect.garmin.com/app/settings/personalApiToken directly.

Pick **1 year** and copy the key right away, because Garmin only shows it once.

## 2. Set up Google sign-in

At https://console.cloud.google.com (free):

1. New project, then **OAuth consent screen**: External, app name, your email. Leave it in **Testing** and add your Google email as a **test user**.
2. **Clients → Create client → Web application**, with the redirect URI
   `https://<your-app>.vercel.app/oauth/google/callback`

## 3. Deploy to Vercel (free Hobby plan)

```sh
npm install
npx vercel login
npx vercel link                                        # creates the project
npx vercel env add GARMIN_PERSONAL_API_KEY production  # the Garmin key
npx vercel env add GOOGLE_CLIENT_ID production
npx vercel env add GOOGLE_CLIENT_SECRET production
npx vercel env add OAUTH_SIGNING_SECRET production     # npm run secret
npx vercel env add ACCOUNT_EMAIL production            # your Google email
npx vercel deploy --prod
```

Or push to a **private** GitHub repo, import it at vercel.com/new and add the same variables there.

Use the **production** URL (`<project>.vercel.app`). Preview URLs sit behind Vercel's login, and Claude can't get past it.

## 4. Add it to Claude

1. In Claude, go to Settings → Connectors → **Add custom connector**.
2. Name it `Garmin` and paste `https://<your-app>.vercel.app/api/mcp`. Leave the OAuth client fields empty; Claude registers itself.
3. Click **Connect** and sign in with Google.
4. In a chat, click **+** → Connectors and switch Garmin on.

Things to try:
- "What were my runs this week, with pace and average HR?"
- "How has my sleep and HRV trended over the last month?"
- "Pull the FIT file for my last ride and show heart rate per lap."

## How sign-in behaves

- Access tokens last an hour and refresh tokens 30 days. Every refresh checks `ACCOUNT_EMAIL` again, so removing an email cuts that person off within the hour.
- `ACCOUNT_EMAIL` takes several comma-separated emails if you want to sign in from more than one Google account.
- **To sign everyone out at once**, change `OAUTH_SIGNING_SECRET` and redeploy. Nothing is stored server-side, so single tokens can't be revoked.
- Only Claude's own callback URLs (and localhost, for Claude Code) can receive sign-in codes.

## Fallback: a secret in the URL

For clients that can't do OAuth, set `CONNECTOR_SECRET` (`npm run secret`, at least 24 URL-safe characters) and use
`https://<your-app>.vercel.app/api/mcp?key=<CONNECTOR_SECRET>`. A wrong key gets a plain 404.

Prefer OAuth: a `?key=` URL is a password that never expires, and it shows up in Vercel's request logs. Leave `CONNECTOR_SECRET` unset to keep this off.

Quick check from a terminal (needs the fallback on):

```sh
URL='https://<your-app>.vercel.app/api/mcp?key=<CONNECTOR_SECRET>'
curl -s -X POST "$URL" \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_activities","arguments":{"limit":1}}}'
```

| What you see | Meaning |
|---|---|
| Your latest activity | Ready |
| `Token exchange failed` | The Garmin key is wrong or expired |
| `Not found` | Wrong secret, or a URL that isn't the production one |
| A 503 message | An environment variable is missing. Fix it and redeploy |

## Another person's Garmin data

Give them their own deployment (their own Vercel project, Garmin key and `ACCOUNT_EMAIL`). Garmin's Personal API is for your own data, so each account stays in its own deployment.

## Keeping it running

- **The Garmin key expires.** Garmin emails you about a week before. Create a new key, update `GARMIN_PERSONAL_API_KEY` in Vercel, and redeploy.
- **It's personal use only.** Garmin's Personal API terms allow tools you run for your own data. Don't offer it as a service.

## Hosting somewhere other than Vercel

`npm start` runs a plain Node server (`standalone.js`) with the same paths (`/api/mcp`, `/oauth/*`, `/.well-known/*`). Behind a proxy, set `PUBLIC_URL` to the public HTTPS address. This works on Railway, Render, Fly, a VPS or a Raspberry Pi. It binds to `$PORT` when the platform sets one.

On your own machine, put HTTPS in front of it (Caddy, Cloudflare Tunnel). Claude connects from Anthropic's cloud, so the server has to be reachable from the public internet.

## Files

| File | Role |
|---|---|
| `lib/handler.js` | Checks the caller (OAuth token or `?key=`), then forwards to garmin-personal-mcp with an internal bearer token |
| `lib/account.js` | Reads the account (Garmin key, allowed emails, optional secret) from the environment |
| `lib/oauth.js` | OAuth server for Claude, with sign-in delegated to Google |
| `lib/tokens.js` | HMAC-signed tokens, so nothing has to be stored |
| `api/mcp.js` | Vercel function (GET/POST/DELETE) |
| `api/oauth.js` | Vercel function for `/oauth/*` and `/.well-known/*` (routed by `vercel.json`) |
| `standalone.js` | Node server for other hosts and local testing |
