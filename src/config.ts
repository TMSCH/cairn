import { readFile, lstat, open, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { randomBytes } from "node:crypto";
import { z } from "zod";
export async function privateJson(path: string): Promise<unknown> {
  if (!isAbsolute(path))
    throw new Error("Use an absolute private configuration path");
  const stat = await lstat(path);
  if (
    !stat.isFile() ||
    (stat.mode & 0o077) !== 0 ||
    stat.uid !== process.getuid?.()
  )
    throw new Error("Private files must be owner-only regular files");
  return JSON.parse(await readFile(path, "utf8"));
}
export async function savePrivate(path: string, value: unknown) {
  if (!isAbsolute(path)) throw new Error("Use an absolute private path");
  const parent = await lstat(dirname(path));
  if (!parent.isDirectory() || (parent.mode & 0o077) !== 0 || parent.uid !== process.getuid?.())
    throw new Error("Private directory must be owner-only");
  const temp = `${path}.${randomBytes(8).toString("hex")}.new`;
  const file = await open(temp, "wx", 0o600);
  try {
    await file.writeFile(JSON.stringify(value, null, 2));
    await file.sync();
    await file.close();
    await rename(temp, path);
    const directory = await open(dirname(path), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch (error) {
    await file.close().catch(() => {});
    await unlink(temp).catch(() => {});
    throw error;
  }
}
export const connectConfigSchema = z
  .object({
    port: z.number().int().min(1024).max(65535).default(8790),
    publicOrigin: z.string().url().refine((v) => {
      const url = new URL(v);
      return url.protocol === "https:" && url.origin === v && !url.username && !url.password;
    }),
    expectedGoogleEmail: z.string().email(),
    googleCredentials: z.string().refine(isAbsolute),
    googleTokens: z.string().refine(isAbsolute),
  })
  .strict();
export const configSchema = z
  .object({
    port: z.number().int().min(1024).max(65535).default(8789),
    googleCredentials: z.string(),
    googleTokens: z.string(),
    clients: z
      .array(
        z
          .object({
            tokenSha256: z.string().regex(/^[a-f0-9]{64}$/),
            tools: z.array(z.string().regex(/^[a-z][a-z0-9_]{1,63}$/)),
          })
          .strict(),
      )
      .min(1),
    classifier: z
      .object({
        command: z.string().refine(isAbsolute),
        args: z.array(z.string()),
      })
      .strict(),
  })
  .strict();
export const credentialsSchema = z.object({
  client_id: z.string().min(1),
  client_secret: z.string().min(1),
});
export const tokensSchema = z.object({ refresh_token: z.string().min(1) });
