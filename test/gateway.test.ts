import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { Gateway } from "../src/core.js";
import { normalize, registerGmail } from "../src/gmail.js";
import { httpServer } from "../src/http.js";
import { LocalClassifier } from "../src/classifier.js";
import type { gmail_v1 } from "@googleapis/gmail";
const email = (text: string, id = "abc"): gmail_v1.Schema$Message => ({
  id,
  payload: {
    mimeType: "text/plain",
    headers: [
      { name: "Subject", value: "Doctor visit" },
      { name: "From", value: "doctor@example.com" },
    ],
    body: { data: Buffer.from(text).toString("base64url") },
  },
});
function fixture() {
  const calls: any[] = [];
  const gets: any[] = [];
  const api = {
    users: {
      messages: {
        list: async () => ({
          data: {
            messages: [{ id: "safe" }, { id: "private" }],
            resultSizeEstimate: 999,
          },
        }),
        get: async (args: any) => {
          gets.push(args);
          const message = email(
            args.id === "private" ? "Diagnosis: confidential" : "Appointment at 10",
            args.id,
          );
          if (args.format === "metadata") {
            message.payload!.headers![0].value =
              args.id === "private" ? "Confidential diagnosis" : "Doctor visit";
            message.snippet = "PRIVATE_SNIPPET";
          }
          return { data: message };
        },
      },
      drafts: {
        create: async (args: any) => {
          calls.push(args);
          return { data: { id: "r-123", message: { snippet: "PRIVATE" } } };
        },
      },
    },
  };
  const inspected: string[] = [];
  const gateway = new Gateway({
    allows: async (text) => {
      inspected.push(text);
      return !text.toLowerCase().includes("confidential");
    },
  });
  registerGmail(gateway, api as unknown as gmail_v1.Gmail);
  return { gateway, calls, gets, inspected, api };
}
test("search classifies metadata only and omits bodies, snippets and raw counts", async () => {
  const { gateway, inspected, gets } = fixture();
  const result = await gateway.execute("gmail_search", { query: "doctor" }, [
    "gmail_search",
  ]);
  assert.equal(result.items.length, 1);
  assert.equal(inspected.length, 2);
  assert(!JSON.stringify(result).includes("confidential"));
  assert(!JSON.stringify(result).includes("999"));
  assert(!JSON.stringify(result).includes("Appointment at 10"));
  assert(!JSON.stringify(result).includes("PRIVATE_SNIPPET"));
  assert(!inspected.some((text) => text.includes("Diagnosis")));
  assert.deepEqual(gets.map((x) => x.format), ["metadata", "metadata"]);
  assert(inspected[0].includes("Doctor visit"));
});
test("direct read cannot bypass filtering", async () => {
  const { gateway, gets } = fixture();
  assert.deepEqual(
    await gateway.execute("gmail_read", { id: "private" }, ["gmail_read"]),
    { items: [] },
  );
  assert.deepEqual(gets.map((x) => x.format), ["full"]);
});
test("an allowed search result does not authorize its sensitive body", async () => {
  const { gateway, api } = fixture();
  api.users.messages.get = async ({ id }: any) => ({
    data: email("Diagnosis: confidential", id),
  });
  assert.equal(
    (await gateway.execute("gmail_search", { query: "doctor" }, ["gmail_search"])).items.length,
    2,
  );
  assert.deepEqual(
    await gateway.execute("gmail_read", { id: "safe" }, ["gmail_read"]),
    { items: [] },
  );
});
test("HTML-only, attached, invalid and incomplete bodies are withheld", () => {
  for (const payload of [
    { mimeType: "text/html", body: { data: "YWJj" } },
    { mimeType: "text/plain", filename: "test.txt", body: { data: "YWJj" } },
    { mimeType: "text/plain", body: { attachmentId: "private" } },
    { mimeType: "text/plain", body: { data: "_w" } },
    { mimeType: "text/plain", body: { size: 999 } },
    {
      mimeType: "text/plain",
      headers: [
        { name: "Content-Type", value: "text/plain; charset=iso-8859-1" },
      ],
      body: { data: "YWJj" },
    },
  ]) {
    const value = normalize({ id: "x", payload });
    assert.equal(value.kind === "message" && value.supported, false);
  }
});
test("plain text is readable alongside HTML and attachments without exposing them", () => {
  const value = normalize({
    id: "x",
    payload: {
      mimeType: "multipart/mixed",
      parts: [
        { mimeType: "text/plain", body: { data: Buffer.from("Newsletter text").toString("base64url") } },
        { mimeType: "text/html", body: { data: Buffer.from("<a href='https://example.com'>HTML</a>").toString("base64url") } },
        { mimeType: "text/plain", filename: "private.txt", body: { attachmentId: "secret" } },
        { mimeType: "text/plain", headers: [{ name: "Content-Disposition", value: "attachment" }], body: { data: Buffer.from("SECRET_ATTACHMENT").toString("base64url") } },
      ],
    },
  });
  assert.equal(value.kind, "message");
  if (value.kind !== "message") return;
  assert.equal(value.supported, true);
  assert.equal(value.value.body, "Newsletter text");
});
test("capabilities enforced before side effects; sending never registered", async () => {
  const { gateway, calls } = fixture();
  await assert.rejects(
    gateway.execute(
      "gmail_create_draft",
      { to: ["a@example.com"], subject: "s", body: "b" },
      ["gmail_read"],
    ),
  );
  await assert.rejects(gateway.execute("gmail_send", {}, ["gmail_send"]));
  assert.equal(calls.length, 0);
});
test("draft returns only receipt and prevents header injection", async () => {
  const { gateway, calls } = fixture();
  const args = {
    to: ["a@example.com"],
    subject: "Hello é 😀",
    body: "Draft body",
  };
  assert.deepEqual(
    await gateway.execute("gmail_create_draft", args, ["gmail_create_draft"]),
    { items: [{ id: "r-123" }] },
  );
  assert(
    Buffer.from(calls[0].requestBody.message.raw, "base64url")
      .toString()
      .includes("Content-Transfer-Encoding: base64"),
  );
  await assert.rejects(
    gateway.execute(
      "gmail_create_draft",
      { ...args, subject: "x\r\nBcc: evil@example.com" },
      ["gmail_create_draft"],
    ),
  );
  assert.equal(calls.length, 1);
});
test("classifier failure and oversized source do not disclose data", async () => {
  const gateway = new Gateway({
    allows: async () => {
      throw new Error("secret");
    },
  });
  registerGmail(gateway, fixture().api as unknown as gmail_v1.Gmail);
  await assert.rejects(
    gateway.execute("gmail_read", { id: "safe" }, ["gmail_read"]),
  );
  const candidate = normalize(email("x".repeat(33000)));
  assert.equal(candidate.kind === "message" && candidate.supported, false);
});
test("local classifier accepts typed verdict, fails closed on malformed output and missing executable", async () => {
  for (const [output, expected] of [
    ['{"decision":"allow"}', true],
    ['{"decision":"uncertain"}', false],
    ["garbage", false],
  ] as const) {
    const classifier = new LocalClassifier(process.execPath, [
      "-e",
      `process.stdin.on('data',()=>console.log(${JSON.stringify(output)}))`,
    ]);
    try {
      assert.equal(await classifier.allows("appointment"), expected);
    } finally {
      classifier.close();
    }
  }
  const absent = new LocalClassifier("/nonexistent-executable", []);
  assert.equal(await absent.allows("x"), false);
  absent.close();
});
test("HTTP authentication, tool visibility and sanitized provider errors", async () => {
  const { gateway, api } = fixture();
  api.users.messages.get = async () => {
    throw new Error("PRIVATE_PROVIDER_CONTENT");
  };
  const token = randomBytes(32).toString("base64url");
  const server = httpServer(
    gateway,
    [
      {
        tokenSha256: createHash("sha256").update(token).digest("hex"),
        tools: ["gmail_read"],
      },
    ],
    18789,
  );
  await new Promise<void>((r) => server.listen(18789, "127.0.0.1", r));
  try {
    const request = async (body: unknown, extra: Record<string, string> = {}) =>
      fetch("http://127.0.0.1:18789/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          Authorization: `Bearer ${token}`,
          ...extra,
        },
        body: JSON.stringify(body),
      });
    assert.equal(
      (await request({}, { Authorization: "Bearer wrong" })).status,
      401,
    );
    assert.equal(
      (await request({}, { Origin: "http://evil.example" })).status,
      403,
    );
    const list = (await (
      await request({ jsonrpc: "2.0", id: 1, method: "tools/list" })
    ).json()) as any;
    assert.deepEqual(
      list.result.tools.map((t: any) => t.name),
      ["gmail_read"],
    );
    const read = await (
      await request({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "gmail_read", arguments: { id: "abc" } },
      })
    ).text();
    assert(!read.includes("PRIVATE_PROVIDER_CONTENT"));
    assert(read.includes("Operation unavailable"));
    const denied = await (
      await request({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "gmail_create_draft", arguments: {} },
      })
    ).text();
    assert(!denied.includes("r-123"));
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
