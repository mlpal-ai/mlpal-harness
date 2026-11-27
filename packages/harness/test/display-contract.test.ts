import { readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { recordNoDisplayRun } from "./fixtures/display/no-display-run";

const golden = readFileSync(new URL("./fixtures/display/no-display-run.golden.json", import.meta.url), "utf8");

let root = "";
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

describe("display contract: a client that says nothing about display", () => {
  test("sees byte-identical events, and the model byte-identical requests, to the engine before the protocol", async () => {
    root = join(tmpdir(), `yodex-display-contract-${crypto.randomUUID()}`);
    const rec = await recordNoDisplayRun(root);
    expect(JSON.stringify(rec, null, 2) + "\n").toBe(golden);
  });
});
