import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { EngineEvent, SDKMessage } from "@mlpal/harness-protocol";
import { GatewayError, type ModelClient, type ModelRequest, type ModelResult } from "../src/gateway/client";
import type { ImageGateway, ImageJob, ImageRequest, ImageResult } from "../src/gateway/images";
import { AgentSession } from "../src/loop/agent";
import { createPolicy } from "../src/permission/engine";
import { LocalStore } from "../src/store/local";
import { ToolRegistry } from "../src/tools/registry";
import { createGenerateImageTool } from "../src/tools/builtin/image";

/**
 * Review-media R5, round 2: an engine that dies mid-call. The job is journalled before submit, its id when the gateway
 * names it, the charge when the gateway reports it; a resumed engine reconciles from that record, by the job id,
 * never by a new submit, and records the charge exactly once. A dead engine is a call whose promise never resolves.
 */
const magic = JSON.parse(readFileSync(new URL("../../protocol/test/fixtures/display/media-magic.vectors.json", import.meta.url), "utf8")) as { vectors: Array<{ name: string; hex: string }> };
const PNG = Buffer.from(magic.vectors.find((v) => v.name === "png 1536x1024")!.hex, "hex");
const DAY = "2026-11-28";
const CU = 0.19;
const never = () => new Promise<never>(() => {});

class ScriptedModel implements ModelClient {
  private i = 0;
  constructor(private readonly scripts: ModelResult[]) {}
  async *stream(_req: ModelRequest): AsyncGenerator<never, ModelResult, void> {
    const r = this.scripts[this.i++];
    if (!r) throw new GatewayError("script exhausted", 500);
    return r;
  }
}
const toolUse = (input: Record<string, unknown>): ModelResult => ({ model: "test", message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_img", name: "GenerateImage", input }] }, usage: { input_tokens: 10, output_tokens: 5 }, stopReason: "tool_use" });
const done = (text: string): ModelResult => ({ model: "test", message: { role: "assistant", content: [{ type: "text", text }] }, usage: { input_tokens: 8, output_tokens: 4 }, stopReason: "end_turn" });

/** The gateway's state, shared by both engines (it outlives them): its jobs and every submit it took. Idempotency as
 *  the real one (image_jobs.submit_job): one job per (user, key), whatever API key the user calls with. */
class Gateway {
  submits: Array<{ key: string; n: number; apiKey: string }> = [];
  jobs = new Map<string, ImageResult>();
  byKey = new Map<string, string>();
  /** Where the first engine dies: in the submit's answer, in a poll, or in the download of image `i`. */
  constructor(public die: { at: "submit" | "poll" | "download"; image?: number } | null) {}
  client(engine: 1 | 2, apiKey = "key-a"): ImageGateway {
    let downloads = 0;
    return {
      submit: async (req: ImageRequest, opts: { idempotencyKey: string }) => {
        this.submits.push({ key: opts.idempotencyKey, n: req.n, apiKey });
        const known = this.byKey.get(`user-1/${opts.idempotencyKey}`);
        if (known) return { job: { status: "queued", id: known } as ImageJob };
        const id = `job-${this.jobs.size + 1}`;
        this.byKey.set(`user-1/${opts.idempotencyKey}`, id);
        this.jobs.set(id, { data: Array.from({ length: req.n }, (_, i) => ({ url: `https://assets.test/${id}/${i}.png` })), model: "m", cost: { compute_units: CU } });
        if (engine === 1 && this.die?.at === "submit") return never();
        return { job: { status: "queued", id } as ImageJob };
      },
      job: async (id: string) => {
        if (engine === 1 && this.die?.at === "poll") return never();
        const result = this.jobs.get(id);
        if (!result) throw new Error("404 no such job");
        return { status: "succeeded", id, result } as ImageJob;
      },
      download: async () => {
        const i = downloads++;
        if (engine === 1 && this.die?.at === "download" && i === (this.die.image ?? 0)) return never();
        return PNG;
      },
    };
  }
}

let root: string;
let cwd: string;
beforeEach(() => {
  root = join(tmpdir(), `genimg-crash-${crypto.randomUUID()}`);
  cwd = join(root, "work");
  mkdirSync(cwd, { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

type ToolOpts = { estimate?: number | null; payer?: string };
const tool = (gw: ImageGateway, at = `${DAY}T10:00:00Z`, o: ToolOpts = {}) =>
  createGenerateImageTool({ images: gw, models: () => [], estimate: () => (o.estimate === undefined ? 0.01 : o.estimate), now: () => new Date(at), sleep: async () => {}, pollMs: 1, ...(o.payer ? { payer: () => o.payer } : {}) });
function session(store: LocalStore, model: ModelClient, gw: ImageGateway, at?: string, o: ToolOpts = {}) {
  const tools = new ToolRegistry();
  tools.register(tool(gw, at, o) as never);
  return new AgentSession({ agentId: "ag", sessionId: "s1", workspace: "w", cwd, model: "test", systemPrompt: "t", tools, store, model_client: model, canUseTool: createPolicy({ mode: "autopilot" }), onAsk: async () => ({ behavior: "allow" }) });
}
async function drain(gen: AsyncGenerator<EngineEvent, unknown, void>): Promise<EngineEvent[]> {
  const out: EngineEvent[] = [];
  for (;;) {
    const n = await gen.next();
    if (n.done) return out;
    out.push(n.value);
  }
}
/** Runs the first engine until it dies at the gateway's point, then a second resumes the session from disk. */
async function crashAndResume(gw: Gateway, input: Record<string, unknown> = { prompt: "a red fox" }, resume: { at?: string; apiKey?: string; first?: ToolOpts; second?: ToolOpts } = {}) {
  const dir = join(root, "store");
  const first = new LocalStore(dir);
  void drain(session(first, new ScriptedModel([toolUse(input), done("ok")]), gw.client(1), undefined, resume.first).run({ text: "make a fox" }));
  // the first engine is now stuck where it died; what it wrote durably is all the second one finds
  for (let i = 0; i < 200 && !(await deadYet(first, gw)); i++) await new Promise((r) => setTimeout(r, 5));
  await first.flush?.();
  const second = new LocalStore(dir);
  const events = await drain(session(second, new ScriptedModel([done("resumed")]), gw.client(2, resume.apiKey), resume.at, resume.second).resume() as never);
  const entries = (await new LocalStore(dir).conversation.read("s1")).map((e) => e.payload as SDKMessage & { usage?: { compute_units?: number } });
  const recorded = entries.reduce((s, e) => s + (e.type === "result" ? (e.usage?.compute_units ?? 0) : 0), 0);
  const unpriced = entries.reduce((s, e) => s + (e.type === "result" ? ((e.usage as { unpriced_charges?: number } | undefined)?.unpriced_charges ?? 0) : 0), 0);
  const unconfirmed = entries.reduce((s, e) => s + (e.type === "result" ? ((e.usage as { compute_units_unconfirmed?: number } | undefined)?.compute_units_unconfirmed ?? 0) : 0), 0);
  const result = events.find((e) => e.type === "tool_result") as { content: string; isError?: boolean } | undefined;
  const spends = (await new LocalStore(dir).readEvents("s1", "tool_spend")).length;
  return { result, recorded, unconfirmed, unpriced, spends, files: existsSync(join(cwd, "media", DAY)) ? readdirSync(join(cwd, "media", DAY)).filter((f) => !f.startsWith(".")).sort() : [] };
}
/** The first engine reached its death point. */
async function deadYet(store: LocalStore, gw: Gateway): Promise<boolean> {
  if (gw.die?.at === "submit") return gw.submits.length === 1;
  const journal = await store.readEvents("s1", "tool_journal");
  if (gw.die?.at === "poll") return journal.some((e) => (e.data as { phase?: string }).phase === "job");
  return (await store.readEvents("s1", "tool_spend")).length === 1;
}

describe("R5: a GenerateImage call whose engine dies is reconciled on resume, by its job, never by a new submit", () => {
  test("killed between the job's record and its charge (mid-poll): the job is polled, charged once, saved", async () => {
    const gw = new Gateway({ at: "poll" });
    const r = await crashAndResume(gw);
    expect([gw.submits.length, r.spends, r.recorded, r.result?.isError ?? false, r.files]).toEqual([1, 1, CU, false, ["a-red-fox-1.png"]]);
    expect(r.result?.content).toMatch(/^wrote media\/2026-11-28\/a-red-fox-1\.png/);
  });

  test("killed between the charge and the save: the charge is not recorded again, the same job is saved", async () => {
    const gw = new Gateway({ at: "download", image: 0 });
    const r = await crashAndResume(gw);
    expect([gw.submits.length, r.spends, r.recorded, r.result?.isError ?? false, r.files]).toEqual([1, 1, CU, false, ["a-red-fox-1.png"]]);
  });

  test("killed during the download of the second of two: both are saved from the same job, charged once", async () => {
    const gw = new Gateway({ at: "download", image: 1 });
    const r = await crashAndResume(gw, { prompt: "a red fox", n: 2 });
    expect([gw.submits.length, r.spends, r.recorded, r.result?.isError ?? false]).toEqual([1, 1, CU, false]);
    // the first image was saved before the engine died, and again on resume under the next free name: never overwritten
    expect(r.files).toEqual(["a-red-fox-1-2.png", "a-red-fox-1.png", "a-red-fox-2.png"]);
  });

  test("killed before the job's id is recorded, resumed inside the window: the same request under the same key, one render, one charge, saved", async () => {
    const gw = new Gateway({ at: "submit" });
    const r = await crashAndResume(gw, { prompt: "a red fox" }, { at: `${DAY}T11:00:00Z` });
    expect([gw.submits.map((x) => x.key), gw.jobs.size, r.spends, r.recorded, r.result?.isError ?? false, r.files]).toEqual([["toolu_img", "toolu_img"], 1, 1, CU, false, ["a-red-fox-1.png"]]);
  });

  test("resumed outside the window: no submit; the person is told once; the spend is an unconfirmed estimate", async () => {
    const gw = new Gateway({ at: "submit" });
    const r = await crashAndResume(gw, { prompt: "a red fox" }, { at: `2026-11-29T10:00:01Z` });
    expect([gw.submits.length, r.spends, r.recorded, r.unconfirmed, r.result?.isError, r.files]).toEqual([1, 1, 0, 0.01, true, []]);
    expect(r.result?.content).toContain("IMAGE_UNCONFIRMED");
    expect(r.result?.content).toContain(`at ${DAY}T10:00:00.000Z`);
    expect(r.result?.content).toContain("an estimated 0.010 CU");
  });

  test("resumed under a different API key (a workspace's key changes at wake): the gateway scopes the key to the user, so the original job, one charge", async () => {
    const gw = new Gateway({ at: "submit" });
    const r = await crashAndResume(gw, { prompt: "a red fox" }, { at: `${DAY}T10:30:00Z`, apiKey: "key-b" });
    expect([gw.submits.map((x) => x.apiKey), gw.jobs.size, r.spends, r.recorded, r.files]).toEqual([["key-a", "key-b"], 1, 1, CU, ["a-red-fox-1.png"]]);
  });
});

describe("R5, round 3: the payer, and an unconfirmed charge with no estimate", () => {
  test("a resume whose paying user is not the request's: no resubmit, the unconfirmed note", async () => {
    const gw = new Gateway({ at: "submit" });
    const r = await crashAndResume(gw, { prompt: "a red fox" }, { at: `${DAY}T10:30:00Z`, first: { payer: "user-1" }, second: { payer: "user-2" } });
    expect([gw.submits.length, r.recorded, r.unconfirmed, r.result?.content.includes("IMAGE_UNCONFIRMED"), r.result?.content.includes("paying user")]).toEqual([1, 0, 0.01, true, true]);
  });

  test("the same payer resumes as before: one job, one charge", async () => {
    const same = new Gateway({ at: "submit" });
    const ok = await crashAndResume(same, { prompt: "a red fox" }, { at: `${DAY}T10:30:00Z`, first: { payer: "user-1" }, second: { payer: "user-1" } });
    expect([same.jobs.size, ok.recorded]).toEqual([1, CU]);
  });

  test("an unconfirmed charge with no estimate is counted as unknown (an unpriced charge), never as zero", async () => {
    const late = new Gateway({ at: "submit" });
    const r = await crashAndResume(late, { prompt: "a red fox" }, { at: "2026-11-29T10:00:01Z", first: { estimate: null }, second: { estimate: null } });
    expect([late.submits.length, r.recorded, r.unconfirmed, r.unpriced]).toEqual([1, 0, 0, 1]);
    expect(r.result?.content).toContain("an unknown amount");
  });
});

/** A gateway whose job runs past the caller's deadline, then finishes (and bills) once `finish()` is called. */
function lateGateway() {
  let finished = false;
  const result: ImageResult = { data: [{ url: "https://assets.test/late/0.png" }], model: "m", cost: { compute_units: CU } };
  const submits: string[] = [];
  const gw: ImageGateway = {
    submit: async (_req, opts) => (submits.push(opts.idempotencyKey), { job: { status: "queued", id: "job-late" } as ImageJob }),
    job: async (id) => (finished ? ({ status: "succeeded", id, result } as ImageJob) : ({ status: "running", id } as ImageJob)),
    download: async () => PNG,
  };
  return { gw, submits, finish: () => void (finished = true) };
}
function lateSession(store: LocalStore, sessionId: string, calls: Array<Record<string, unknown>>, gw: ImageGateway, afterCall?: (n: number) => void) {
  let t = new Date(`${DAY}T10:00:00Z`).getTime();
  const tools = new ToolRegistry();
  // the clock moves a minute per look, so a running job reaches the 10-minute deadline
  const img = createGenerateImageTool({ images: gw, models: () => [], estimate: () => 0.01, now: () => new Date((t += 60_000)), sleep: async () => {}, pollMs: 1 });
  const call = img.call.bind(img);
  let n = 0;
  img.call = async (input, ctx) => {
    const r = await call(input, ctx);
    afterCall?.(n++);
    return r;
  };
  tools.register(img as never);
  const model = new ScriptedModel([...calls.map((input, i) => ({ ...toolUse(input), message: { role: "assistant" as const, content: [{ type: "tool_use" as const, id: `toolu_${sessionId}_${i}`, name: "GenerateImage", input }] } })), done("ok")]);
  return new AgentSession({ agentId: "ag", sessionId, workspace: "w", cwd, model: "test", systemPrompt: "t", tools, store, model_client: model, canUseTool: createPolicy({ mode: "autopilot" }) });
}
const charges = async (store: LocalStore, sid: string) => (await store.readEvents(sid, "tool_spend")).map((e) => [e.once, (e.usage as { compute_units?: number }).compute_units]);

describe("R5b: a charge is recorded where the engine first learns of it, once per job", () => {
  test("a call that times out, then {job} twice: the charge recorded once, by the first save", async () => {
    const late = lateGateway();
    const store = new LocalStore(join(root, "store"));
    // the gateway finishes and bills after the first call gave up
    const s = lateSession(store, "s1", [{ prompt: "a red fox" }, { job: "job-late" }, { job: "job-late" }], late.gw, (n) => n === 0 && late.finish());
    const events = await drain(s.run({ text: "make a fox" }));
    const results = events.filter((e) => e.type === "tool_result") as Array<{ content: string; isError?: boolean }>;
    expect(results[0]!.content).toContain('GenerateImage {job: "job-late"}');
    expect([results[1]!.isError ?? false, results[2]!.isError ?? false, late.submits.length]).toEqual([false, false, 1]);
    expect(await charges(store, "s1")).toEqual([["job:job-late", CU]]);
    expect((events.at(-1) as { usage?: { compute_units?: number } }).usage?.compute_units).toBeCloseTo(CU, 6);
  });

  test("another session of the same person cannot save the job, so the charge is recorded in the session that made it, when it learns of it", async () => {
    const late = lateGateway();
    const store = new LocalStore(join(root, "store"));
    await drain(lateSession(store, "s1", [{ prompt: "a red fox" }], late.gw).run({ text: "make a fox" }));
    late.finish();
    const other = await drain(lateSession(store, "s2", [{ job: "job-late" }], late.gw).run({ text: "save it" }));
    const refused = other.find((e) => e.type === "tool_result") as { content: string; isError?: boolean };
    expect([refused.isError, refused.content.includes("not one this session made"), (await charges(store, "s2")).length]).toEqual([true, true, 0]);
    await drain(lateSession(store, "s1", [{ job: "job-late" }], late.gw).run({ text: "save it" }));
    expect(await charges(store, "s1")).toEqual([["job:job-late", CU]]);
  });
});

describe("R5: IMAGE_NOT_SAVED's job is saved again in the same session, with no new render or charge", () => {
  test("a failed save, then GenerateImage {job}: the same images, submits 1, the charge once; a job of no call of this session is refused", async () => {
    const gw = new Gateway(null);
    let fail = true;
    const client = gw.client(2);
    const flaky: ImageGateway = { ...client, download: async (url, o) => (fail ? Promise.reject(new Error("storage hiccup")) : client.download(url, o)) };
    const store = new LocalStore(join(root, "store"));
    const tools = new ToolRegistry();
    tools.register(tool(flaky) as never);
    const model = new ScriptedModel([toolUse({ prompt: "a red fox" }), { ...toolUse({ job: "job-1" }), message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_again", name: "GenerateImage", input: { job: "job-1" } }] } }, done("ok")]);
    const s = new AgentSession({ agentId: "ag", sessionId: "s1", workspace: "w", cwd, model: "test", systemPrompt: "t", tools, store, model_client: model, canUseTool: createPolicy({ mode: "autopilot" }) });
    const original = tools.get("GenerateImage")!;
    const realCall = original.call.bind(original);
    let calls = 0;
    original.call = async (input, ctx) => {
      const r = await realCall(input, ctx);
      if (calls++ === 0) fail = false; // the second call's download works
      return r;
    };
    const events = await drain(s.run({ text: "make a fox" }));
    const results = events.filter((e) => e.type === "tool_result") as Array<{ content: string; isError?: boolean }>;
    expect(results[0]!.content).toContain('GenerateImage {job: "job-1"}');
    expect(results[0]!.content).toContain("one hour after the render");
    expect([results[1]!.isError ?? false, results[1]!.content.startsWith("wrote media/2026-11-28/a-red-fox-1"), gw.submits.length]).toEqual([false, true, 1]);
    expect((await store.readEvents("s1", "tool_spend")).length).toBe(1);
    const final = events.at(-1) as { usage?: { compute_units?: number } };
    expect(final.usage?.compute_units).toBeCloseTo(CU, 6);
    // asking for a job this session never made
    const stranger = await tools.get("GenerateImage")!.call({ job: "job-999" } as never, { cwd, roots: [cwd], toolUseId: "toolu_x", journal: { append: async () => {}, read: async () => [] } });
    expect([stranger.isError, String(stranger.content)]).toEqual([true, expect.stringContaining("not one this session made")]);
    // saving again is never asked as a cost
    expect(tools.get("GenerateImage")!.alwaysAsk?.({ job: "job-1" })).toBeNull();
  });
});
