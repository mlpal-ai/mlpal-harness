import { readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import type { DisplayCaps } from "@mlpal/harness-protocol";
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

  // The controller's ruling (review 1, finding 5): Show and the catalog only for a client that declares the block
  // level, so a client that declares text (the terminal) or blocks it cannot get from this catalog is served as today.
  const base: DisplayCaps = { v: 1, client: "cli", levels: ["text", "file"], catalogs: [], viewport: "desktop", theme: "dark", locale: "en-US", timeZone: "UTC" };
  const clients: Array<[string, DisplayCaps]> = [
    ["text and file only (the terminal)", base],
    ["text only", { ...base, levels: ["text"] }],
    ["blocks, but not from catalog harness.v1/1", { ...base, client: "web", levels: ["text", "block"], catalogs: ["other.v9/1"] }],
    ["blocks, but none of this catalog's kinds", { ...base, client: "web", levels: ["text", "block"], catalogs: ["harness.v1/1"], kinds: ["sankey"] }],
  ];
  for (const [name, caps] of clients) {
    test(`a client that declares ${name} sees the same: no Show, the host's prompt, the same events`, async () => {
      root = join(tmpdir(), `yodex-display-contract-${crypto.randomUUID()}`);
      const rec = await recordNoDisplayRun(root, caps);
      expect(JSON.stringify(rec, null, 2) + "\n").toBe(golden);
    });
  }
});
