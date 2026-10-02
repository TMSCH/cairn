import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { z } from "zod";
import type { Classifier } from "./core.js";

// Private pipes: no classifier HTTP endpoint, cloud fallback, or content logging.
export class LocalClassifier implements Classifier {
  private child: ChildProcessWithoutNullStreams;
  private pending?: {
    resolve: (value: boolean) => void;
    timer: NodeJS.Timeout;
  };
  private busy = false;
  private dead = false;
  constructor(command: string, args: string[]) {
    this.child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1" },
    });
    this.child.stderr.resume();
    const fail = () => {
      this.dead = true;
      if (this.pending) {
        clearTimeout(this.pending.timer);
        this.pending.resolve(false);
        this.pending = undefined;
      }
    };
    this.child.on("error", fail);
    this.child.on("exit", fail);
    const lines = createInterface({ input: this.child.stdout });
    lines.on("line", (line) => {
      if (!this.pending) return;
      let allowed = false;
      try {
        const result = z
          .object({ decision: z.enum(["allow", "deny", "uncertain"]) })
          .strict()
          .parse(JSON.parse(line));
        allowed = result.decision === "allow";
      } catch {
        this.dead = true;
        this.child.kill();
      }
      clearTimeout(this.pending.timer);
      this.pending.resolve(allowed);
      this.pending = undefined;
    });
  }
  async allows(text: string): Promise<boolean> {
    if (this.busy || this.dead || Buffer.byteLength(text) > 48_000)
      return false;
    this.busy = true;
    try {
      return await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => {
          this.dead = true;
          this.child.kill();
          this.pending = undefined;
          resolve(false);
        }, 120_000);
        this.pending = { resolve, timer };
        this.child.stdin.write(JSON.stringify({ text }) + "\n", (error) => {
          if (error) {
            clearTimeout(timer);
            this.pending = undefined;
            this.dead = true;
            resolve(false);
          }
        });
      });
    } finally {
      this.busy = false;
    }
  }
  close() {
    this.child.kill();
  }
}
