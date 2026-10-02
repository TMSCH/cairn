import { test } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectionServer, googleOAuthFlow, type GoogleOAuthFlow } from "../src/connect.js";

test("Google consent URL uses the registered HTTPS callback, scopes, state and PKCE", async () => {
  const flow = googleOAuthFlow({ client_id: "test-client", client_secret: "test-secret" }, "https://connect.tch.dev");
  const { url, verifier } = await flow.start("one-time-state");
  const consent = new URL(url);
  assert.equal(consent.searchParams.get("redirect_uri"), "https://connect.tch.dev/google/callback");
  assert.equal(consent.searchParams.get("state"), "one-time-state");
  assert.equal(consent.searchParams.get("code_challenge_method"), "S256");
  assert.equal(consent.searchParams.get("access_type"), "offline");
  assert(consent.searchParams.get("scope")?.includes("gmail.readonly"));
  assert(consent.searchParams.get("scope")?.includes("gmail.compose"));
  assert(verifier.length > 30);
});

test("web connection saves only an approved account token and rejects replay", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cairn-connect-"));
  const tokenPath = join(dir, "google-tokens.json");
  let state = "";
  let email = "wrong@example.com";
  const flow: GoogleOAuthFlow = {
    async start(s) {
      state = s;
      return { url: `https://accounts.google.com/example?state=${s}`, verifier: "test-verifier" };
    },
    async finish(code, verifier) {
      assert.equal(verifier, "test-verifier");
      assert.equal(code, "once");
      return { refreshToken: "PRIVATE_REFRESH_TOKEN", email };
    },
  };
  const server = connectionServer(
    { publicOrigin: "https://connect.tch.dev", expectedGoogleEmail: "owner@example.com", googleTokens: tokenPath },
    flow,
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const call = (path: string, method = "GET", headers: Record<string, string> = {}) =>
    new Promise<{ status: number; body: string; location?: string }>((resolve, reject) => {
      const req = request({ hostname: "127.0.0.1", port, path, method,
        headers: { Host: "connect.tch.dev", ...headers } }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0,
          body: Buffer.concat(chunks).toString(), location: res.headers.location }));
      });
      req.on("error", reject);
      req.end();
    });
  try {
    assert.equal((await call("/", "GET", { Host: "evil.example" })).status, 403);
    assert.equal((await call("/google/start", "POST", { Origin: "https://evil.example" })).status, 403);
    assert.equal((await call("/google/start", "POST", { Origin: "https://connect.tch.dev" })).status, 303);
    assert.equal((await call("/google/callback?state=wrong&code=once")).status, 400);
    await assert.rejects(readFile(tokenPath));
    assert.equal((await call("/google/start", "POST", { Origin: "https://connect.tch.dev" })).status, 303);
    assert.equal((await call(`/google/callback?state=${state}&code=once`)).status, 403);
    await assert.rejects(readFile(tokenPath));
    email = "owner@example.com";
    assert.equal((await call("/google/start", "POST", { Origin: "https://connect.tch.dev" })).status, 303);
    const callback = `/google/callback?state=${state}&code=once`;
    assert.equal((await call(callback)).status, 200);
    assert.equal((await call(callback)).status, 400);
    const saved = JSON.parse(await readFile(tokenPath, "utf8"));
    assert.deepEqual(saved, { refresh_token: "PRIVATE_REFRESH_TOKEN" });
    assert.equal((await stat(tokenPath)).mode & 0o077, 0);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});
