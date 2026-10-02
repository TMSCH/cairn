import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import { gmail } from "@googleapis/gmail";
import { OAuth2Client, CodeChallengeMethod } from "google-auth-library";
import { connectConfigSchema, credentialsSchema, privateJson, savePrivate } from "./config.js";

const scopes = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.compose",
];

const pageStyle = `
:root{color-scheme:dark;font-family:Inter,ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
*{box-sizing:border-box}
body{min-height:100vh;margin:0;display:grid;place-items:center;padding:24px;color:#f5f2ec;background:radial-gradient(circle at 18% 15%,#374b42 0,transparent 35%),radial-gradient(circle at 85% 88%,#293a3d 0,transparent 38%),#101b1c}
main{width:min(100%,490px);padding:36px;border:1px solid #ffffff24;border-radius:24px;background:#1c2a2ad9;box-shadow:0 24px 70px #0005}
.brand{display:flex;align-items:center;gap:12px;margin-bottom:36px;font-size:15px;font-weight:700;letter-spacing:.08em;text-transform:uppercase}
.mark{display:grid;place-items:center;width:34px;height:34px;border-radius:10px;background:#b9d7b5;color:#17352d;font-size:22px;font-family:Georgia,serif}
.eyebrow{margin:0 0 12px;color:#bad8b5;font-size:12px;font-weight:700;letter-spacing:.16em;text-transform:uppercase}
h1{margin:0;font-family:Georgia,serif;font-size:clamp(36px,8vw,48px);font-weight:500;line-height:1.08;letter-spacing:-.035em}
.intro{margin:20px 0 25px;color:#d2dad5;font-size:16px;line-height:1.6}
ul{margin:0 0 28px;padding:0;list-style:none}
li{display:flex;gap:12px;align-items:baseline;padding:11px 0;border-top:1px solid #ffffff1b;color:#eef2ed;font-size:14px}
li::before{content:"✓";color:#bad8b5;font-weight:700}
.button{display:block;width:100%;padding:15px 20px;border:0;border-radius:12px;background:#c7e1bd;color:#14251f;font-family:inherit;font-size:15px;font-weight:700;text-align:center;text-decoration:none;cursor:pointer}
.button:hover{background:#def1d4}
.button:focus-visible{outline:3px solid #fff;outline-offset:3px}
.note{margin:19px 0 0;color:#a9b8b2;font-size:12px;line-height:1.55}
`;
const pageHtml = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect Google · Cairn</title><style>${pageStyle}</style></head><body><main><div class="brand"><span class="mark" aria-hidden="true">C</span>Cairn</div><p class="eyebrow">Google connection</p><h1>Connect Gmail to Nestor</h1><p class="intro">Cairn gives Nestor limited access to your inbox while keeping your Google credentials separate.</p><ul><li>Search email and read approved plain text</li><li>Prepare drafts for you to review</li><li>No send action is available to Nestor</li></ul><a class="button" href="/google/start?nonce=__START_NONCE__">Continue with Google</a><p class="note">Google’s compose permission also covers sending. Cairn holds that permission but exposes only draft creation to Nestor.</p></main></body></html>`;
const pageStyleHash = createHash("sha256").update(pageStyle).digest("base64");

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
  const startNonces = new Map<string, number>();
  const host = new URL(config.publicOrigin).host;
  return createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", `default-src 'none'; style-src 'sha256-${pageStyleHash}'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`);
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
      const nonce = randomBytes(32).toString("base64url");
      for (const [key, expiry] of startNonces)
        if (expiry < Date.now()) startNonces.delete(key);
      if (startNonces.size >= 20) startNonces.delete(startNonces.keys().next().value!);
      startNonces.set(nonce, Date.now() + 300_000);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(pageHtml.replace("__START_NONCE__", nonce));
      return;
    }
    if (url.pathname === "/google/start") {
      const nonce = url.searchParams.get("nonce");
      const expires = nonce && startNonces.get(nonce);
      if (req.method !== "GET" || url.searchParams.size !== 1 || !nonce || !expires || expires < Date.now()) {
        res.writeHead(303, { Location: "/" });
        res.end();
        return;
      }
      startNonces.delete(nonce);
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
