// Plain Node server for Railway, Render, Fly, a VPS or a Raspberry Pi.
// Same URL shape as Vercel: http(s)://<host>/api/mcp, plus /oauth/* and /.well-known/*.
// Behind an HTTPS proxy, set PUBLIC_URL (e.g. https://garmin.example.com) for OAuth.
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { MCP_PATH } from "./lib/account.js";
import { handle } from "./lib/handler.js";
import { handleOAuth } from "./lib/oauth.js";

const port = Number(process.env.PORT ?? 3333);
const host = process.env.HOST ?? (process.env.PORT ? "0.0.0.0" : "127.0.0.1");

createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const route =
      MCP_PATH.test(url.pathname) ? handle
      : url.pathname.startsWith("/oauth/") || url.pathname.startsWith("/.well-known/") ? handleOAuth
      : null;
    if (!route) {
      res.writeHead(404, { "content-type": "text/plain" }).end("Not found");
      return;
    }
    const hasBody = req.method !== "GET" && req.method !== "HEAD";
    const request = new Request(url, {
      method: req.method,
      headers: Object.entries(req.headers).flatMap(([k, v]) =>
        v === undefined ? [] : Array.isArray(v) ? v.map((x) => [k, x]) : [[k, v]],
      ),
      body: hasBody ? Readable.toWeb(req) : undefined,
      duplex: "half",
    });
    const response = await route(request);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body) for await (const chunk of response.body) res.write(chunk);
    res.end();
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  }
}).listen(port, host, () => console.error(`Garmin connector listening on http://${host}:${port}/api/mcp`));
