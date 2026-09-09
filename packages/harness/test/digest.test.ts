import { describe, expect, test } from "bun:test";
import { digestTool } from "../src/tools/builtin/digest";

const ctx = { cwd: "/" };

describe("Digest tool", () => {
  test("sha256 by default, hex, read-only", async () => {
    expect(digestTool.readOnly).toBe(true);
    const r = await digestTool.call({ text: "aws ec2 delete-volume --volume-id vol-0f9e8d7c6b5a41203" }, ctx);
    expect(r.content).toMatch(/^[0-9a-f]{64}$/);
    expect((await digestTool.call({ text: "x" }, ctx)).content).toBe("2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881");
  });
  test("is deterministic and algorithm-selectable", async () => {
    const a = await digestTool.call({ text: "x" }, ctx);
    const b = await digestTool.call({ text: "x" }, ctx);
    expect(a.content).toBe(b.content);
    expect((await digestTool.call({ text: "x", algorithm: "sha1" }, ctx)).content).toHaveLength(40);
  });
});
