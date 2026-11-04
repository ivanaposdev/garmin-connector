// Vercel function for the OAuth endpoints. vercel.json rewrites /oauth/* and
// /.well-known/* here; the request keeps its original path for routing.
import { handleOAuth } from "../lib/oauth.js";

export const GET = handleOAuth;
export const POST = handleOAuth;
export const OPTIONS = handleOAuth;
