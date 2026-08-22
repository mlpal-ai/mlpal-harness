import { afterAll, describe, expect, test } from "bun:test";
import { configureHost, host, hostDir, hostEnv, hostEnvName } from "../src/host";
import { defaultMemoryNames } from "../src/memory/memory";

/** The engine is product-neutral: a different host identity changes every identity-
 *  derived surface, and the yodex defaults hold when no host configures anything. */
describe("host identity seam", () => {
  afterAll(() => {
    configureHost({}); // restore defaults for any later test in this process
  });

  test("defaults are yodex's (existing embedders change nothing)", () => {
    configureHost({});
    expect(host().name).toBe("yodex");
    expect(hostDir("/home/u", "config.json")).toBe("/home/u/.yodex/config.json");
    expect(hostEnvName("MODEL")).toBe("YODEX_MODEL");
    expect(defaultMemoryNames()).toEqual(["YODEX.md", "AGENTS.md", "CLAUDE.md"]);
  });

  test("a different product rebrands paths, env vars, and memory names", () => {
    configureHost({ name: "acme", configDirName: ".acme", envPrefix: "ACME" });
    expect(hostDir("/home/u", "hops", "legal")).toBe("/home/u/.acme/hops/legal");
    expect(hostEnv({ ACME_MODEL: "m1", YODEX_MODEL: "m2" }, "MODEL")).toBe("m1");
    expect(defaultMemoryNames()[0]).toBe("ACME.md");
  });
});
