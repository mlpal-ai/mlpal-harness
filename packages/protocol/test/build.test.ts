import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

/**
 * The built package must load where it is consumed: the web UI's image build runs this package's build and imports
 * its output, and a published package is imported by Node (review 6: both entries of a two-entry `bun build` failed
 * to load, "Export 'blockRows2' is not defined"). The package's own build script is run into a fresh directory inside
 * the package (so `zod` resolves as it would for a consumer), and both entries are imported by a plain Node process
 * (Bun when Node is absent), which checks they agree.
 */
const pkg = new URL("..", import.meta.url).pathname;
const runtime = Bun.which("node") ?? process.execPath;
const env = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" };

describe("the built package", () => {
  test("both entries import in a plain process, and the subpath gives the root's functions", () => {
    const out = mkdtempSync(join(pkg, ".build-test-"));
    try {
      const build = Bun.spawnSync([process.execPath, "scripts/build.ts", out], { cwd: pkg, env, stdout: "pipe", stderr: "pipe" });
      expect([build.exitCode, build.stderr.toString()]).toEqual([0, ""]);
      const probe = `
        const root = await import(${JSON.stringify(join(out, "index.js"))});
        const sub = await import(${JSON.stringify(join(out, "display/validate.js"))});
        const same = ["validateBlock", "chartCost", "checkShowInput", "blockRows", "fallbackInputSchema"].every((k) => typeof sub[k] !== "undefined" && sub[k] === root[k]);
        const ok = root.displayEnvelopeSchema && root.HARNESS_PROTOCOL_VERSION && sub.validateBlock("kpis", { tiles: [{ id: "a", label: "A", value: 1, format: "number" }] }).ok;
        if (!same || !ok) { console.error("mismatch", same, ok); process.exit(1); }
        console.log("loaded");`;
      const run = Bun.spawnSync(runtime === process.execPath ? [runtime, "-e", probe] : [runtime, "--input-type=module", "-e", probe], { cwd: pkg, env, stdout: "pipe", stderr: "pipe" });
      expect([run.exitCode, run.stdout.toString().trim(), run.stderr.toString()]).toEqual([0, "loaded", ""]);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  }, 60_000);
});
