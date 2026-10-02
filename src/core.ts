import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/server";

export interface Classifier {
  allows(text: string): Promise<boolean>;
}
export const messageSchema = z
  .object({
    id: z.string(),
    from: z.string(),
    to: z.string(),
    subject: z.string(),
    date: z.string(),
    body: z.string(),
  })
  .strict();
export type Message = z.infer<typeof messageSchema>;
export const metadataSchema = z
  .object({
    id: z.string(),
    from: z.string(),
    subject: z.string(),
    date: z.string(),
  })
  .strict();
export type Metadata = z.infer<typeof metadataSchema>;
export type Candidate =
  | { kind: "message"; value: Message; supported: boolean }
  | { kind: "metadata"; value: Metadata; supported: boolean }
  | { kind: "receipt"; id: string };
export interface Tool {
  name: string;
  description: string;
  input: z.ZodObject;
  policy: "messages" | "metadata" | "draftReceipt";
  run(input: any): Promise<Candidate[]>;
}
export class Gateway {
  private tools = new Map<string, Tool>();
  constructor(private classifier: Classifier) {}
  register(tool: Tool) {
    if (this.tools.has(tool.name)) throw new Error("Duplicate tool");
    this.tools.set(tool.name, tool);
  }
  async execute(name: string, input: unknown, grants: readonly string[]) {
    const tool = this.tools.get(name);
    if (!tool || !grants.includes(name)) throw new Error("Unavailable");
    const candidates = await tool.run(tool.input.parse(input));
    const output: unknown[] = [];
    for (const candidate of candidates) {
      if (
        (tool.policy === "messages" && candidate.kind === "message") ||
        (tool.policy === "metadata" && candidate.kind === "metadata")
      ) {
        // Classify exactly the fields that can leave the process, once.
        const value = (candidate.kind === "message" ? messageSchema : metadataSchema).parse(candidate.value);
        const text = JSON.stringify(value);
        if (
          candidate.supported &&
          Buffer.byteLength(text) <= 48_000 &&
          (await this.classifier.allows(text))
        )
          output.push(value);
      } else if (
        tool.policy === "draftReceipt" &&
        candidate.kind === "receipt"
      ) {
        output.push(
          z
            .object({ id: z.string().regex(/^[a-zA-Z0-9_-]{1,256}$/) })
            .strict()
            .parse({ id: candidate.id }),
        );
      } else throw new Error("Invalid disclosure policy");
    }
    return { items: output };
  }
  mcp(grants: readonly string[]) {
    const server = new McpServer({
      name: "cairn",
      version: "0.1.0",
    });
    for (const tool of this.tools.values())
      if (grants.includes(tool.name)) {
        server.registerTool(
          tool.name,
          { description: tool.description, inputSchema: tool.input },
          async (input) => {
            try {
              const result = await this.execute(tool.name, input, grants);
              return {
                content: [
                  { type: "text" as const, text: JSON.stringify(result) },
                ],
              };
            } catch {
              return {
                isError: true,
                content: [
                  {
                    type: "text" as const,
                    text: "Operation unavailable. No content was disclosed.",
                  },
                ],
              };
            }
          },
        );
      }
    return server;
  }
}
