# 200-email local classifier benchmark

This benchmark was frozen before scoring: [the manifest](benchmark-200-manifest.json) records the 200-case corpus hash, policy and runner hashes, model revisions, thresholds, CPU threads and batch size. The [corpus](benchmark-200.json) has exactly 100 synthetic emails labeled sensitive and 100 labeled non-sensitive, with ten varied categories per label. All model runs used the same `privacy-only-v3` gate: six privacy hypotheses for the NLI models or six labeled categories for GLiClass, plus the structured-secret check, with sensitive threshold 0.1 and allow threshold 0.9. No threshold or prompts were tuned after looking at these results.

| Local CPU candidate | Sensitive emails allowed through | Non-sensitive emails allowed | Single-email median | Eight-email batches, all 200 | Peak process RAM |
| --- | ---: | ---: | ---: | ---: | ---: |
| DeBERTa base | **4/100** | **90/100** | 0.72 s | 119 s | 1,074 MiB |
| DeBERTa xsmall | 3/100 | 39/100 | 0.21 s | 37 s | 812 MiB |
| GLiClass edge | 0/100 | 0/100 | 0.013 s | 2.8 s | 646 MiB |

All timing was on this development Mac with two CPU threads. It excludes Gmail API requests, MIME decoding and MCP transport. It is **not** a VPS benchmark. Batch timing includes only the inference loop after model load; the single-email median uses a fixed 24-case sample after warm-up, not all 200. Each run used one process and all cached model weights remained local. A real batch path is not yet wired into Cairn's MCP gateway.

The DeBERTa base misses were an implicit personal symptom report, backup codes, a wallet recovery phrase and a Spanish temporary password. The xsmall model missed two intimate facts and one quoted private detail. GLiClass edge blocked everything, so its zero leaks are not useful. [Per-case outputs](benchmark-200-deberta-base.json), [xsmall outputs](benchmark-200-deberta-xsmall.json) and [edge outputs](benchmark-200-gliclass-edge.json) contain scores, decisions and timings without email text.

The test set was authored by the same assistant that developed the policy. It contains more varied, unique wording and category coverage than the earlier sets, but is still synthetic and shares likely blind spots. A balanced 100/100 mix is not a real inbox distribution; accuracy or precision computed from it would mislead. Labels for ambiguous personal or public material were chosen by the author and need owner review. Now that model selection has used this benchmark, it is development data, not a final untouched test set. A final decision needs a fresh, owner-reviewed sample and no threshold tuning on that sample.

## Search impact

After this benchmark, [Gmail search](../src/gmail.ts) was changed to fetch only selected headers for at most **20** candidates, with no pagination. [Core](../src/core.ts) classifies and returns only IDs, senders, subjects and dates. Full bodies are fetched and independently classified only by `gmail_read`. This benchmark measured full synthetic emails, so its 0.72-second median cannot be used as a subject-classification latency estimate. Google calls add latency too. Hundreds of results are not scanned.

The next engineering step is to measure end-to-end search and read latency on the actual 4-vCPU VPS. Metadata classification only controls metadata disclosure; it never approves a body. Page tokens, caching and batching can wait until profiling shows a need. Keep plain-text-only reads and no attachment exposure for this version.

The four misses are concrete evidence that this classifier can disclose private material, including secrets. The owner has said some leakage is acceptable for an initial version, so DeBERTa base is now the provisional runtime default. Representative private examples and a VPS performance check are still needed before relying on it.

Model sources: [DeBERTa base](https://huggingface.co/MoritzLaurer/deberta-v3-base-zeroshot-v2.0), [DeBERTa xsmall](https://huggingface.co/MoritzLaurer/deberta-v3-xsmall-zeroshot-v1.1-all-33), [GLiClass edge](https://huggingface.co/knowledgator/gliclass-instruct-edge-v1.0).
