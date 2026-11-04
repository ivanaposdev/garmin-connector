# Garmin connector

A claude.ai custom connector that wraps garmin-personal-mcp (see README).

## Auth: OAuth is the way in

Claude connects with **OAuth** (Google sign-in, `lib/oauth.js`): the connector URL is plain `/api/mcp`, and access is decided by the emails in `ACCOUNT_EMAIL`. Point users and new setups at OAuth. `?key=<CONNECTOR_SECRET>` is a fallback for clients without OAuth; it stays opt-in (off when the variable is unset), and auth changes keep it that way.

## One deployment, one Garmin account

Each deployment serves exactly one person's Garmin account. Another person gets their own deployment; Garmin's Personal API terms cover only your own data.

## The repo stays free of personal data

Keep secrets, real names, real email addresses and deployment URLs in Vercel env vars and local `.env*` files (gitignored). Docs and examples use placeholders like `<your-app>` and `you@example.com`. Scan the diff for these before every commit.
