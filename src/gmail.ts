import { z } from "zod";
import type { gmail_v1 } from "@googleapis/gmail";
import type { Candidate, Gateway } from "./core.js";

export function normalize(message: gmail_v1.Schema$Message): Candidate {
  const p = message.payload;
  const headers = p?.headers ?? [];
  const header = (name: string) =>
    headers
      .filter((h) => h.name?.toLowerCase() === name)
      .map((h) => h.value ?? "")
      .join(", ");
  let supported = !!p,
    size = 0;
  const bodies: string[] = [];
  const visit = (part: gmail_v1.Schema$MessagePart, depth = 0) => {
    if (depth > 20) {
      supported = false;
      return;
    }
    const disposition = (part.headers ?? []).find(
      (h) => h.name?.toLowerCase() === "content-disposition",
    )?.value ?? "";
    if (part.filename || part.body?.attachmentId || /^\s*attachment\b/i.test(disposition)) {
      // Attachments are never fetched or disclosed. A body part must still exist.
      return;
    }
    if (part.mimeType?.startsWith("multipart/")) {
      for (const child of part.parts ?? []) visit(child, depth + 1);
      return;
    }
    if (part.mimeType !== "text/plain") {
      // A multipart/alternative may include HTML alongside its plain-text body.
      return;
    }
    const contentType =
      (part.headers ?? []).find((h) => h.name?.toLowerCase() === "content-type")
        ?.value ?? "";
    if (
      /charset=/i.test(contentType) &&
      !/charset=["']?(utf-8|us-ascii)["']?(?:;|\s|$)/i.test(contentType)
    ) {
      supported = false;
      return;
    }
    const data = part.body?.data ?? "";
    if (!/^[a-zA-Z0-9_=-]*$/.test(data)) {
      supported = false;
      return;
    }
    try {
      const bytes = Buffer.from(data, "base64url");
      if (part.body?.size != null && part.body.size !== bytes.length) {
        supported = false;
        return;
      }
      size += bytes.length;
      bodies.push(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      supported = false;
    }
  };
  if (p) visit(p);
  if (size > 32_000 || !bodies.length) supported = false;
  const value = {
    id: message.id ?? "",
    from: header("from"),
    to: header("to"),
    subject: header("subject"),
    date: header("date"),
    body: bodies.join("\n"),
  };
  return {
    kind: "message",
    value,
    supported,
  };
}
export function normalizeMetadata(message: gmail_v1.Schema$Message): Candidate {
  const headers = message.payload?.headers ?? [];
  const header = (name: string) =>
    headers
      .filter((h) => h.name?.toLowerCase() === name)
      .map((h) => h.value ?? "")
      .join(", ");
  return {
    kind: "metadata",
    value: {
      id: message.id ?? "",
      from: header("from"),
      subject: header("subject"),
      date: header("date"),
    },
    supported: !!message.id && !!message.payload,
  };
}
const address = z
  .string()
  .email()
  .max(254)
  .refine((v) => !/[\r\n]/.test(v));
export function registerGmail(gateway: Gateway, api: gmail_v1.Gmail) {
  gateway.register({
    name: "gmail_search",
    description:
      "Search Gmail using Gmail query syntax. For recent mail across the mailbox use newer_than:7d; add in:inbox only when the user specifically wants the inbox (it excludes archived mail). Returns all matching IDs, senders, subjects and dates in the requested page WITHOUT sensitivity filtering; no body, snippet or attachment. Default 20, maximum 100 per page. If nextPageToken is returned, pass it with the same query to fetch more; a page is not the full result set. Call gmail_read for a body; listed messages may still be denied on read.",
    input: z
      .object({
        query: z.string().max(500),
        limit: z.number().int().min(1).max(100).default(20),
        pageToken: z.string().min(1).max(4096).optional(),
      })
      .strict(),
    policy: "metadata",
    async run({ query, limit, pageToken }) {
      const result = await api.users.messages.list(
        { userId: "me", q: query, maxResults: limit, pageToken },
        { timeout: 30_000 },
      );
      const items: Candidate[] = [];
      for (const message of result.data.messages ?? [])
        if (message.id)
          items.push(
            normalizeMetadata(
              (
                await api.users.messages.get(
                  {
                    userId: "me",
                    id: message.id,
                    format: "metadata",
                    metadataHeaders: ["From", "Subject", "Date"],
                  },
                  { timeout: 30_000 },
                )
              ).data,
            ),
          );
      return { candidates: items, nextPageToken: result.data.nextPageToken ?? undefined };
    },
  });
  gateway.register({
    name: "gmail_read",
    description:
      "Read one Gmail message by ID through Cairn's privacy filter. Returns plain text only when approved. Sensitive, unsupported or overlong content returns access=denied with an explicit cannot-access message; do not infer that the message is absent or try another access path.",
    input: z
      .object({ id: z.string().regex(/^[a-zA-Z0-9_-]{1,256}$/) })
      .strict(),
    policy: "messages",
    async run({ id }) {
      return [
        normalize(
          (
            await api.users.messages.get(
              { userId: "me", id, format: "full" },
              { timeout: 30_000 },
            )
          ).data,
        ),
      ];
    },
  });
  gateway.register({
    name: "gmail_create_draft",
    description:
      "Create a new plain-text Gmail draft for human review. Never sends. Do not retry automatically: a timeout may follow successful creation.",
    input: z
      .object({
        to: z.array(address).min(1).max(20),
        subject: z
          .string()
          .max(500)
          .refine((v) => !/[\r\n]/.test(v)),
        body: z.string().max(32_000),
      })
      .strict(),
    policy: "draftReceipt",
    async run({ to, subject, body }) {
      const words: string[] = [];
      let word = "";
      for (const char of subject) {
        if (Buffer.byteLength(word + char) > 42) {
          words.push(word);
          word = "";
        }
        word += char;
      }
      if (word) words.push(word);
      const encodedSubject = words
        .map((s) => `=?UTF-8?B?${Buffer.from(s).toString("base64")}?=`)
        .join("\r\n ");
      const encodedBody =
        Buffer.from(body)
          .toString("base64")
          .match(/.{1,76}/g)
          ?.join("\r\n") ?? "";
      const raw = Buffer.from(
        `To: ${to.join(",\r\n ")}\r\nSubject: ${encodedSubject}\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${encodedBody}`,
      ).toString("base64url");
      const result = await api.users.drafts.create(
        { userId: "me", requestBody: { message: { raw } } },
        { timeout: 30_000, retry: false },
      );
      return [{ kind: "receipt", id: result.data.id ?? "" }];
    },
  });
}
