import { describe, expect, test } from "bun:test";
import { JsonLogger } from "../src/obs/logger";
import { MemoryMetrics } from "../src/obs/metrics";

function capture(): { lines: string[]; logger: JsonLogger } {
  const lines: string[] = [];
  const logger = new JsonLogger({
    level: "debug",
    sink: (l) => lines.push(l),
    now: () => "T",
  });
  return { lines, logger };
}

describe("JsonLogger", () => {
  test("emits structured JSON with stable fields", () => {
    const { lines, logger } = capture();
    logger.info("hello", { a: 1 });
    expect(JSON.parse(lines[0]!)).toEqual({ ts: "T", level: "info", msg: "hello", a: 1 });
  });

  test("child loggers carry correlation context", () => {
    const { lines, logger } = capture();
    const child = logger.child({ runId: "r1", sessionId: "s1" });
    child.error("boom", { code: 500 });
    const rec = JSON.parse(lines[0]!);
    expect(rec.runId).toBe("r1");
    expect(rec.sessionId).toBe("s1");
    expect(rec.code).toBe(500);
    // grandchild merges further
    child.child({ tool: "Bash" }).warn("slow");
    expect(JSON.parse(lines[1]!).tool).toBe("Bash");
    expect(JSON.parse(lines[1]!).runId).toBe("r1");
  });

  test("respects the minimum level", () => {
    const lines: string[] = [];
    const logger = new JsonLogger({ level: "warn", sink: (l) => lines.push(l), now: () => "T" });
    logger.debug("noise");
    logger.info("noise");
    logger.warn("kept");
    logger.error("kept");
    expect(lines).toHaveLength(2);
  });
});

describe("MemoryMetrics", () => {
  test("counts and observes with tag keys", () => {
    const m = new MemoryMetrics();
    m.increment("tool.calls", 1, { tool: "Bash" });
    m.increment("tool.calls", 2, { tool: "Bash" });
    m.increment("tool.calls", 1, { tool: "Read" });
    m.histogram("model.latency_ms", 120);
    expect(m.counters.get("tool.calls{tool=Bash}")).toBe(3);
    expect(m.counters.get("tool.calls{tool=Read}")).toBe(1);
    expect(m.observations.get("model.latency_ms")).toEqual([120]);
  });
});
