import { describe, expect, test } from "bun:test";
import { type RunAgent, runWorkflow, type WorkflowContext } from "../src/workflow/runner";

/** A deterministic fake: echoes the prompt, and returns parsed data when a schema is requested. */
const echo: RunAgent = async (prompt, opts) => ({
  text: `ran: ${prompt}`,
  data: opts.schema ? { prompt } : undefined,
});

describe("runWorkflow", () => {
  test("agent() returns text, or parsed data when a schema is given", async () => {
    const out = await runWorkflow({
      runAgent: echo,
      body: async ({ agent }) => ({
        plain: await agent("hello"),
        structured: await agent("give json", { schema: { type: "object" } }),
      }),
    });
    expect(out).toEqual({ plain: "ran: hello", structured: { prompt: "give json" } });
  });

  test("parallel() runs all thunks and maps a thrown thunk to null", async () => {
    const out = (await runWorkflow({
      runAgent: echo,
      body: async ({ parallel, agent }) =>
        parallel([
          () => agent("a"),
          () => Promise.reject(new Error("boom")),
          () => agent("c"),
        ]),
    })) as unknown[];
    expect(out).toEqual(["ran: a", null, "ran: c"]);
  });

  test("pipeline() threads stages per item and drops a throwing item to null", async () => {
    const out = (await runWorkflow({
      runAgent: echo,
      body: async ({ pipeline }) =>
        pipeline(
          [1, 2, 3],
          (_prev, item) => (item as number) * 10,
          (prev, item) => {
            if (item === 2) throw new Error("skip 2");
            return `${prev}!`;
          },
        ),
    })) as unknown[];
    expect(out).toEqual(["10!", null, "30!"]);
  });

  test("concurrency is bounded — never more than N agents run at once", async () => {
    let active = 0;
    let peak = 0;
    const slow: RunAgent = async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 10));
      active--;
      return { text: "ok" };
    };
    await runWorkflow({
      runAgent: slow,
      concurrency: 3,
      body: async ({ parallel, agent }) =>
        parallel(Array.from({ length: 12 }, (_v, i) => () => agent(`t${i}`))),
    });
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1); // it did run some in parallel
  });

  test("phase() and log() emit progress events; agent start/end are reported", async () => {
    const phases: string[] = [];
    const logs: string[] = [];
    const ends: boolean[] = [];
    await runWorkflow({
      runAgent: echo,
      events: {
        onPhase: (t) => phases.push(t),
        onLog: (m) => logs.push(m),
        onAgentEnd: (i) => ends.push(i.ok),
      },
      body: async ({ phase, log, agent }) => {
        phase("Scan");
        log("starting");
        await agent("x");
        phase("Fix");
        await agent("y").catch(() => {});
      },
    });
    expect(phases).toEqual(["Scan", "Fix"]);
    expect(logs).toEqual(["starting"]);
    expect(ends).toEqual([true, true]);
  });

  test("cache: a lookup hit replays without calling runAgent; misses are recorded", async () => {
    let liveCalls = 0;
    const counting: RunAgent = async (prompt) => {
      liveCalls++;
      return { text: `live: ${prompt}` };
    };
    const store = new Map<number, { prompt: string; result: { text: string } }>();
    // Seed seq 1 as if a prior run had computed it.
    store.set(1, { prompt: "a", result: { text: "cached: a" } });
    const recorded: number[] = [];
    const out = (await runWorkflow({
      runAgent: counting,
      cache: {
        lookup: (seq, prompt) => {
          const e = store.get(seq);
          return e && e.prompt === prompt ? e.result : undefined;
        },
        record: (seq, prompt, _opts, result) => {
          recorded.push(seq);
          store.set(seq, { prompt, result: result as { text: string } });
        },
      },
      body: async ({ agent }) => [await agent("a"), await agent("b")],
    })) as unknown[];
    expect(out).toEqual(["cached: a", "live: b"]); // seq 1 replayed, seq 2 ran live
    expect(liveCalls).toBe(1); // only the uncached call hit runAgent
    expect(recorded).toEqual([2]); // only the live call was recorded
  });

  test("budget: spent() accumulates agent tokens and agent() throws once exhausted", async () => {
    const costs: RunAgent = async (prompt) => ({ text: prompt, tokens: 40 });
    const seen: number[] = [];
    await expect(
      runWorkflow({
        runAgent: costs,
        budget: 100, // 40 + 40 = 80 ok; the third would start at 80 < 100 ok; fourth at 120 -> throws
        body: async ({ agent, budget }) => {
          for (let i = 0; i < 10; i++) {
            await agent(`n${i}`);
            seen.push(budget.spent());
          }
        },
      }),
    ).rejects.toThrow(/budget \(100\) exhausted/);
    expect(seen).toEqual([40, 80, 120]); // ran 3 (spent grew past 100), the 4th call threw
  });

  test("budget.remaining() is Infinity when no target is set", async () => {
    let rem = 0;
    await runWorkflow({
      runAgent: async () => ({ text: "ok", tokens: 5 }),
      body: async ({ agent, budget }) => {
        await agent("x");
        rem = budget.remaining();
      },
    });
    expect(rem).toBe(Number.POSITIVE_INFINITY);
  });

  test("workflow() runs a nested workflow via the injected runner; throws without one", async () => {
    const out = await runWorkflow({
      runAgent: echo,
      runNested: async (name, args) => ({ ranNested: name, withArgs: args }),
      body: async ({ workflow }) => workflow("sub", { k: 1 }),
    });
    expect(out).toEqual({ ranNested: "sub", withArgs: { k: 1 } });

    await expect(
      runWorkflow({
        runAgent: echo,
        body: async ({ workflow }: WorkflowContext) => workflow("sub"),
      }),
    ).rejects.toThrow(/one level only/);
  });

  test("the maxAgents cap stops a runaway loop", async () => {
    await expect(
      runWorkflow({
        runAgent: echo,
        maxAgents: 5,
        body: async ({ agent }: WorkflowContext) => {
          for (let i = 0; i < 100; i++) await agent(`n${i}`);
        },
      }),
    ).rejects.toThrow(/5-agent cap/);
  });
});
