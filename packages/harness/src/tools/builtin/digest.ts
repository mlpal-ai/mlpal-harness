import { createHash } from "node:crypto";
import { z } from "zod";
import { defineTool, type Tool } from "../types";

/**
 * Digest: a read-only hash of a string. Exists because a HOP's own result contract may require a
 * hash (the infra HOP binds an approval to `plan_hash = sha256(normalized command)`), and the only
 * shell ways to get one — `printf … | shasum`, `python3 -c 'import hashlib…'` — are exactly what
 * a safety gate refuses headless (a pipe is a chain; `python3 -c` is arbitrary code). Found by the
 * HOP's own deviation memory on 2026-09-09 (memory.policy, hop-v1.1 §9.2).
 */
export const digestTool: Tool<{ text: string; algorithm?: "sha256" | "sha1" | "md5" }> = defineTool({
  name: "Digest",
  description:
    "Hex digest of a string (default sha256). Use it wherever a result needs a hash of a command or plan; never compute hashes through the shell.",
  readOnly: true,
  schema: z.object({
    text: z.string().describe("the exact string to hash (normalize it first: single spaces, no trailing newline)"),
    algorithm: z.enum(["sha256", "sha1", "md5"]).optional().describe("default sha256"),
  }),
  async call(input) {
    const algorithm = input.algorithm ?? "sha256";
    return { content: createHash(algorithm).update(input.text, "utf8").digest("hex") };
  },
});
