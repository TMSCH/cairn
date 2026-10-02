import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { OAuth2Client, CodeChallengeMethod } from "google-auth-library";
import { credentialsSchema, privateJson, savePrivate } from "./config.js";
import { isAbsolute } from "node:path";
// Operator-only utility. Never registered as an MCP tool.
async function authorize() {
  const [credentialsPath, outputPath] = process.argv.slice(2);
  if (!outputPath || !isAbsolute(outputPath))
    throw new Error("Absolute output path required");
  const credentials = credentialsSchema.parse(
    await privateJson(credentialsPath),
  );
  const state = randomBytes(32).toString("hex");
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const auth = new OAuth2Client(
    credentials.client_id,
    credentials.client_secret,
    `http://127.0.0.1:${port}/callback`,
  );
  const { codeVerifier, codeChallenge } =
    await auth.generateCodeVerifierAsync();
  const timer = setTimeout(() => server.close(), 300_000);
  server.on("request", async (req, res) => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
    if (
      url.pathname !== "/callback" ||
      url.searchParams.get("state") !== state ||
      !url.searchParams.get("code")
    ) {
      res.writeHead(400);
      res.end("Invalid callback");
      return;
    }
    server.removeAllListeners("request");
    try {
      const { tokens } = await auth.getToken({
        code: url.searchParams.get("code")!,
        codeVerifier,
      });
      if (!tokens.refresh_token) throw new Error("No refresh token");
      await savePrivate(outputPath, { refresh_token: tokens.refresh_token });
      res.end("Authorization complete. You can close this window.");
      console.log("Saved private Google refresh token.");
    } catch {
      res.writeHead(500);
      res.end("Authorization failed");
      process.exitCode = 1;
    } finally {
      clearTimeout(timer);
      server.close();
    }
  });
  console.log(
    auth.generateAuthUrl({
      access_type: "offline",
      prompt: "consent",
      state,
      code_challenge: codeChallenge,
      code_challenge_method: CodeChallengeMethod.S256,
      scope: [
        "https://www.googleapis.com/auth/gmail.readonly",
        "https://www.googleapis.com/auth/gmail.compose",
      ],
    }),
  );
}
authorize().catch(() => {
  console.error(
    "Authorization failed. Check credentials and private destination.",
  );
  process.exitCode = 1;
});
