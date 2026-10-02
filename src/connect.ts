import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import { gmail } from "@googleapis/gmail";
import { OAuth2Client, CodeChallengeMethod } from "google-auth-library";
import { connectConfigSchema, credentialsSchema, privateJson, savePrivate } from "./config.js";

const scopes = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.compose",
];

export interface GoogleOAuthFlow {
  start(state: string): Promise<{ url: string; verifier: string }>;
  finish(code: string, verifier: string): Promise<{ refreshToken: string; email: string }>;
}

export function googleOAuthFlow(
  credentials: { client_id: string; client_secret: string },
  publicOrigin: string,
): GoogleOAuthFlow {
  const redirectUri = `${publicOrigin}/google/callback`;
  const client = () => new OAuth2Client(credentials.client_id, credentials.client_secret, redirectUri);
  return {
    async start(state) {
      const auth = client();
      const { codeVerifier, codeChallenge } = await auth.generateCodeVerifierAsync();
      return {
        verifier: codeVerifier,
        url: auth.generateAuthUrl({
          access_type: "offline",
          prompt: "consent",
          state,
          code_challenge: codeChallenge,
          code_challenge_method: CodeChallengeMethod.S256,
          scope: scopes,
        }),
      };
    },
    async finish(code, verifier) {
      const auth = client();
      const { tokens } = await auth.getToken({ code, codeVerifier: verifier });
      if (!tokens.refresh_token) throw new Error("No refresh token");
      auth.setCredentials(tokens);
      const profile = await gmail({ version: "v1", auth }).users.getProfile({ userId: "me" }, { timeout: 30_000 });
      if (!profile.data.emailAddress) throw new Error("No account email");
      return { refreshToken: tokens.refresh_token, email: profile.data.emailAddress };
    },
  };
}

export function connectionServer(
  config: { publicOrigin: string; expectedGoogleEmail: string; googleTokens: string },
  flow: GoogleOAuthFlow,
) {
  let pending: { state: string; verifier: string; expires: number } | undefined;
  const host = new URL(config.publicOrigin).host;
  return createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", "default-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
    const reply = (status: number, body = "") => {
      res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(body);
    };
    if (req.headers.host !== host) return reply(403);
    if (!req.url || req.url.length > 2048) return reply(400);
    let url: URL;
    try {
      url = new URL(req.url, config.publicOrigin);
    } catch {
      return reply(400);
    }
    if (url.pathname === "/" && req.method === "GET") {
      if (url.search) return reply(404);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end('<!doctype html><html lang="en"><meta charset="utf-8"><title>Connect Cairn</title><h1>Connect Google to Cairn</h1><p>This grants Gmail read and compose access to Cairn. Google’s compose permission includes sending, but Cairn only exposes search, read and draft tools to Nesta.</p><form action="/google/start" method="post"><button type="submit">Connect Google</button></form></html>');
      return;
    }
    if (url.pathname === "/google/start" && req.method === "POST") {
      if (url.search || req.headers.origin !== config.publicOrigin || Number(req.headers["content-length"] ?? 0) > 0)
        return reply(403);
      pending = undefined;
      const state = randomBytes(32).toString("base64url");
      try {
        const { url: consentUrl, verifier } = await flow.start(state);
        pending = { state, verifier, expires: Date.now() + 300_000 };
        res.writeHead(303, { Location: consentUrl });
        res.end();
      } catch {
        reply(503, "Connection unavailable.");
      }
      return;
    }
    if (url.pathname === "/google/callback" && req.method === "GET") {
      const session = pending;
      pending = undefined;
      const state = url.searchParams.get("state");
      const code = url.searchParams.get("code");
      if (!session || Date.now() > session.expires || state !== session.state || !code || url.searchParams.has("error"))
        return reply(400, "Connection failed. Start again.");
      try {
        const result = await flow.finish(code, session.verifier);
        if (result.email.toLowerCase() !== config.expectedGoogleEmail.toLowerCase())
          return reply(403, "Wrong Google account. Start again.");
        await savePrivate(config.googleTokens, { refresh_token: result.refreshToken });
        reply(200, "Google connected. You can close this page.");
      } catch {
        reply(503, "Connection failed. Start again.");
      }
      return;
    }
    reply(404);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const config = connectConfigSchema.parse(await privateJson(process.argv[2] ?? ""));
    const credentials = credentialsSchema.parse(await privateJson(config.googleCredentials));
    const server = connectionServer(config, googleOAuthFlow(credentials, config.publicOrigin));
    server.listen(config.port, "127.0.0.1", () =>
      console.log(`Cairn connection service listening on 127.0.0.1:${config.port}`),
    );
    server.on("error", () => {
      console.error("Connection listener failed.");
      process.exitCode = 1;
    });
    for (const signal of ["SIGINT", "SIGTERM"] as const)
      process.on(signal, () => server.close());
  } catch {
    console.error("Connection service startup failed. Check private configuration and credentials.");
    process.exitCode = 1;
  }
}
