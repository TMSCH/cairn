# Cairn

A standalone TypeScript MCP service for constrained Google access. This folder has its own dependencies and lockfile and can be moved without changing the parent repository. No production Nestor configuration is modified.

```
Nesta ── bearer token ──> loopback MCP endpoint
                            │ exact tool grants
                            ▼
                         Gmail plugin ── OAuth ──> Gmail
                            │ raw results
                            ▼
                      mandatory core filter
                            │ private pipes
                            ▼
                     local DeBERTa model
                            │ approved content only
                            ▼
                           Nesta
```

## Implemented scope

- `gmail_search`: returns all matching IDs, senders, subjects and dates in a page without sensitivity filtering. It never returns snippets or bodies. Defaults to 20 results, supports up to 100, and returns `nextPageToken` when more results exist; pass it as `pageToken` with the same query.
- `gmail_read`: rechecks the full message on every read. Denied, uncertain, unsupported and oversized messages return an empty list plus `access: "denied"` and a cannot-access message.
- `gmail_create_draft`: creates a new plain-text draft; returns only its ID. It cannot send, update existing drafts, or fetch arbitrary URLs/files. Treat timeouts as an unknown outcome; check Gmail before retrying to avoid duplicates.
- Exact tool grants per gateway token, one Google account per process. Run separate instances/ports/private directories for separate accounts.
- Local DeBERTa subprocess, offline model loading, no cloud inference fallback. Only an `allow` verdict permits body disclosure. Classifier failures fail closed. Search metadata is explicitly allowed without classification; full reads are classified and withheld reads return `access: "denied"` with a clear cannot-access message.

**Read content is limited to UTF-8 / ASCII plain-text MIME.** HTML alternatives and attachments are skipped; a message needs a usable plain-text body. Unsupported plain-text charsets or undecodable body parts withhold the read. No attachment download tool yet, and search does not expose attachment metadata. No redaction yet: an entire returned body is allowed or withheld, including quoted history.

This is an initial implementation, not a verified privacy guarantee. Local model classification can be wrong. On the 200 synthetic-email benchmark, the provisional DeBERTa base policy allowed 4 of 100 labeled-sensitive examples and 90 of 100 labeled-nonsensitive examples. This says little about a real inbox; evaluate representative private examples before relying on it. A listed subject does not imply body approval. Timing and missing results can still reveal limited existence information; this is not a side-channel resistant service.

## Trust boundary

Run the gateway and classifier under a dedicated OS identity that Nesta cannot impersonate. Keep their code, configuration, Google tokens and model files inaccessible for modification by Nesta. Nesta receives only a gateway bearer token. **A directory and `chmod 600` do not isolate two processes running as the same user.** Localhost is a network binding, not credential isolation. Do not deploy this under Nesta's unrestricted shell account.

Google's `gmail.compose` permission also authorizes sending. The prohibition on sending is enforced by this service's fixed handlers and isolation of Google credentials, not by OAuth. Plugins are trusted operator-installed code with the gateway's privileges; the plugin API is not a sandbox. Do not let the agent install plugins or edit service code.

The classifier adapter uses offline Hugging Face settings and local paths. For a hard network boundary, deny network access to the classifier at the OS level. The gateway itself needs HTTPS access to Google. There is no raw content logging or persistence in this implementation. Avoid HTTP debug logging, core dumps, or external process capture in deployment.

## Install and check

Node 22 or newer:

```sh
npm ci
npm run build
npm test
python3 -m unittest discover -s test -p 'test_*.py'
```

Tests use synthetic mail and fake Google/model responses. The HTTP test starts a temporary loopback listener. No tests access Gmail or download weights.

## Operator setup

1. Create a dedicated `cairn` OS user and an operator-owned private directory outside this checkout and outside Nesta's accessible filesystem; set directory permissions to `700` and JSON files to `600`. The service rejects group/world-readable private JSON files and symlink files. The token writer also requires its parent directory to be owner-only.
2. Enable Gmail API in your Google Cloud project, configure OAuth consent and create a **Web application** OAuth client. Register the exact redirect URI `https://connect.tch.dev/google/callback`. For a personal `@gmail.com` account, choose **External** audience and add the account as a test user; **Internal** only allows members of the project's Google Workspace or Cloud Identity organization. External apps in Testing have seven-day refresh tokens, so this is for initial connection testing rather than durable access. Save a private `google-web-client.json` containing only `client_id` and `client_secret` from that client.
3. Copy `connect.example.json` into the private directory as `connect.json`. Set the expected Google account email and private paths. Add a published application route for `connect.tch.dev` on the existing Cloudflare Tunnel pointing to `http://127.0.0.1:8790`. Protect the entire hostname, including `/google/callback`, with a Cloudflare Access application restricted to the owner. Do not add a Bypass rule. The [route details](deploy/cloudflare-route.md) fit the existing `infra` Terraform stack. Start the connection service as the isolated `cairn` identity; a [restartable systemd example](deploy/cairn-connect.service.example) is included:

   ```sh
   npm run connect -- /absolute/private/connect.json
   ```

   Open `https://connect.tch.dev/` in your own browser or phone, pass Cloudflare Access, and press **Connect Google**. The browser returns to the same hostname after consent. Cairn checks one-time state, PKCE and the exact expected Google account, then writes only the refresh token into `googleTokens`. Nothing is written to the browser, Cloudflare storage or the repository. The listener binds only to loopback and has no MCP route. The script requests `gmail.readonly` and `gmail.compose`; the latter also permits sending at Google's scope level, so Cairn's fixed handlers and OS isolation enforce the draft-only boundary. A consent screen in Testing may have refresh-token lifetime restrictions; configure the project appropriately for your deployment.
4. Prepare the [DeBERTa base model](https://huggingface.co/MoritzLaurer/deberta-v3-base-zeroshot-v2.0) in a local Hugging Face snapshot directory named with its full 40-character revision. Use an operator-controlled Python environment with `torch`, `transformers`, `safetensors` and `sentencepiece`; the [evaluation lockfile](evaluation/requirements.lock.txt) records versions used in the experiment. Store a private `deberta-model.json` containing `{"revision":"<40-character revision>","model_path":"/absolute/path/to/the/revision"}`. The adapter loads only local files. Inputs above its 512-token NLI limit return `uncertain` and are withheld; no truncation is used.
5. Generate a random bearer token and its SHA-256 digest using an operator terminal:

   ```sh
   node --input-type=module -e 'import {randomBytes,createHash} from "node:crypto"; const token=randomBytes(32).toString("base64url"); console.log("Token:",token); console.log("Digest:",createHash("sha256").update(token).digest("hex"));'
   ```

   Store the token in Nesta's secret configuration; only the digest goes in the gateway configuration. Treat terminal output as secret.
6. Copy `config.example.json` to the private directory. Replace all paths and the digest, set exact grants, and set permissions to `600`.
7. Start as the isolated gateway identity after Google consent has saved the refresh token. Example [gateway service](deploy/cairn-gateway.service.example) and [path trigger](deploy/cairn-gateway.path.example) units keep this separate from the connection service and start it when the token appears:

   ```sh
   npm start -- /absolute/private/gateway.json
   ```

   Connect an MCP client to `http://127.0.0.1:8789/mcp`, using `Authorization: Bearer <token>`. The endpoint uses stateless Streamable HTTP. Browser-origin requests are rejected. For a remote Nesta, use an authenticated private tunnel; do not bind this prototype to a public interface.

Revoke a client by removing its digest and restarting the service. Revoke Google consent separately through your Google account when needed. If the VPS is lost, restore the service and reconnect at `connect.tch.dev`; Nestor's Git/R2 state backups intentionally exclude authentication secrets. The older `npm run authorize` localhost/Desktop OAuth utility remains available for local development but is not the production phone flow. No live Google authorization, Cloudflare route, or model setup is performed by installing this project.

## Extending

`src/core.ts` owns registration, grants, the mandatory disclosure pass and final serialization. `src/http.ts` owns MCP transport authentication. `src/connect.ts` owns the separate browser-based Google connection flow. `src/gmail.ts` owns Google-specific schemas, calls and normalization. `src/classifier.ts` owns the local process protocol; `classifier/deberta_adapter.py` adapts the model.

A trusted plugin registers a tool with a name, description, Zod input schema, disclosure policy and handler. Handlers return internal candidates, never MCP responses. Currently core accepts message metadata, full-message candidates, or tightly validated draft receipts. A Drive plugin should add a document candidate/schema and shared document disclosure policy, then register its handlers. Do not add a generic "safe" output escape hatch or upstream API passthrough. Only core produces MCP responses. No dynamic plugin loading, database, framework or frontend is required.

To move this project: move the whole folder, run `npm ci && npm run build`, and update the absolute classifier path and launch command. Credentials stay in the separate private directory.

## Local privacy classifier experiment

See [evaluation/README.md](evaluation/README.md) for the classifier development history and [the 200-email benchmark](evaluation/BENCHMARK_200.md) for the latest CPU comparison. DeBERTa base is the provisional local classifier because the user accepts imperfect filtering for a first version; it has not been validated on real mail or profiled on the VPS. No live Google authorization or model installation has been performed.

## Next milestones

- Evaluate subject metadata and full bodies on representative private examples, especially medical scheduling versus clinical records.
- Profile DeBERTa and Gmail metadata fetches on the target VPS; add caching only if latency needs it.
- Add HTML normalization and local attachment extraction when useful, preserving complete classification before releasing content or bytes.
- Add a deployment unit with OS isolation suited to the actual host; connect Nesta after that isolation and model validation are in place.
- Add Drive through the same mandatory output pipeline.
