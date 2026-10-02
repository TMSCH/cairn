import { gmail } from "@googleapis/gmail";
import { OAuth2Client } from "google-auth-library";
import {
  configSchema,
  credentialsSchema,
  privateJson,
  tokensSchema,
} from "./config.js";
import { LocalClassifier } from "./classifier.js";
import { Gateway } from "./core.js";
import { registerGmail } from "./gmail.js";
import { httpServer } from "./http.js";
try {
  const config = configSchema.parse(await privateJson(process.argv[2] ?? ""));
  const credentials = credentialsSchema.parse(
    await privateJson(config.googleCredentials),
  );
  const tokens = tokensSchema.parse(await privateJson(config.googleTokens));
  const auth = new OAuth2Client(
    credentials.client_id,
    credentials.client_secret,
  );
  auth.setCredentials(tokens);
  const classifier = new LocalClassifier(
    config.classifier.command,
    config.classifier.args,
  );
  const gateway = new Gateway(classifier);
  registerGmail(gateway, gmail({ version: "v1", auth }));
  const server = httpServer(gateway, config.clients, config.port);
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.listen(config.port, "127.0.0.1", () =>
    console.log(`Gateway listening on 127.0.0.1:${config.port}/mcp`),
  );
  server.on("error", () => {
    classifier.close();
    console.error("Gateway listener failed.");
    process.exitCode = 1;
  });
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.on(signal, () => {
      classifier.close();
      server.close();
    });
} catch {
  console.error(
    "Gateway startup failed. Check private configuration, permissions, and credentials.",
  );
  process.exitCode = 1;
}
