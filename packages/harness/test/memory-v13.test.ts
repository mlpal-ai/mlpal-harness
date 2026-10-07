import { describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CODING_PROFILE } from "../src/profile/builtins/coding";
import { fillWorkspace } from "../src/profile/load";
import { createSandbox, resolveSandboxSpec } from "../src/sandbox";
import { SyncingMemory } from "../src/store/graph-memory";
import { LocalStore } from "../src/store/local";
import { classifyFailure, FAILURE_CLASS_VOCAB } from "../src/telemetry/contract";

describe("memory v13 host obligations", () => {
  test("F4: the sync store sends the host's identity headers, not a bare Bearer", async () => {
    const root = join(tmpdir(), `yodex-v13-${crypto.randomUUID()}`);
    const store = new LocalStore(root);
    try {
      const seen: Record<string, string>[] = [];
      const mem = new SyncingMemory({
        base: store.memory,
        endpoint: "https://memory.example",
        apiKey: "bare-key",
        headers: () => ({ authorization: "Bearer from-keyring", "X-Test-Org-Id": "org-1", "X-Test-User-Id": "u-7" }),
        post: async (_url, _body, headers) => {
          seen.push(headers);
          return 202;
        },
      });
      await mem.writeTopic("project-notes", "# notes\n- a fact\n");
      expect(seen).toHaveLength(1);
      expect(seen[0]!["X-Test-Org-Id"]).toBe("org-1");
      expect(seen[0]!["X-Test-User-Id"]).toBe("u-7");
      expect(seen[0]!.authorization).toBe("Bearer from-keyring");
      expect(seen[0]!["content-type"]).toBe("application/json");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("F54: the coding HOP's memory module tells the model how to settle a contested memory", async () => {
    const { CODING_WORK_MEMORY_PROMPT } = await import("../src/profile/builtins/coding");
    expect(CODING_WORK_MEMORY_PROMPT).toContain("contested, ask the person: 'A' [memory://node/<a>] vs 'B' [memory://node/<b>]");
    expect(CODING_WORK_MEMORY_PROMPT).toContain("memory_resolve(keep=<the confirmed id>, retire=[<the other id>], reason=<the person's words>)");
    expect(CODING_WORK_MEMORY_PROMPT).toContain("do not write a third fact");
    expect(CODING_WORK_MEMORY_PROMPT).toContain("(disputed, unconfirmed against");
    expect(CODING_WORK_MEMORY_PROMPT).toContain("after it, do not `memory_write` the same decision again");
  });

  test("F18: with a contract mapper, a Memorize is mirrored under its contract topic or kept local", async () => {
    const root = join(tmpdir(), `yodex-v13-${crypto.randomUUID()}`);
    const store = new LocalStore(root);
    try {
      const posted: { topic: string; key: string; kind: string }[] = [];
      const mem = new SyncingMemory({
        base: store.memory,
        endpoint: "https://memory.example",
        topicFor: ({ type, scope }) => (type === "decision" && scope === "project" ? "work/ledger/decision" : undefined),
        post: async (_url, body) => {
          const e = JSON.parse(body).episodes[0];
          posted.push({ topic: e.payload.topic, key: e.payload.key, kind: e.payload.kind });
          return 202;
        },
      });
      await mem.writeTopic("ledger--eur-only", "---\ntype: decision\nscope: project\nworkspace: ledger\n---\nRefunds are EUR only.\n");
      await mem.writeTopic("ledger--dev-preference-brevity", "---\ntype: deviation\nscope: project\nworkspace: ledger\n---\nkind: preference\n");
      expect(posted).toEqual([{ topic: "work/ledger/decision", key: "eur-only", kind: "decision" }]);
      expect(await store.memory.readTopic("ledger--dev-preference-brevity")).toContain("kind: preference"); // local still has it
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("F1: bubblewrap on PATH but unable to confine is reported, never claimed active", () => {
    const spec = resolveSandboxSpec(undefined, { roots: ["/work/repo"], home: "/home/u", hasSafetyBlock: false });
    const sb = createSandbox(spec, {
      platform: "linux",
      bwrapPath: "/usr/bin/bwrap",
      bwrapProbe: () => ({ ok: false, detail: "bwrap: setting up uid map: Permission denied" }),
      baseEnv: {},
    });
    expect(sb.available).toBe(false);
    expect(sb.platform).toBeNull();
    expect(sb.reason).toContain("cannot confine here");
    expect(sb.reason).toContain("apparmor_restrict_unprivileged_userns");
    expect(sb.describe()).toContain("NOT confined");
    expect(sb.wrap(["true"])).toEqual(["true"]); // identity: nothing pretends to confine
    const ok = createSandbox(spec, { platform: "linux", bwrapPath: "/usr/bin/bwrap", bwrapProbe: () => ({ ok: true }), baseEnv: {} });
    expect(ok.available).toBe(true);
    expect(ok.platform).toBe("bwrap");
    sb.close();
    ok.close();
  });

  test("F8: a parked run has its own result and failure class", () => {
    expect(classifyFailure("parked")).toBe("question_parked");
    expect(classifyFailure("success")).toBeNull();
    expect(FAILURE_CLASS_VOCAB).toBe("failure_class_vocab@v3");
  });

  test("F2: the coding HOP carries the contract and the module; fillWorkspace lands {workspace} everywhere", () => {
    expect(CODING_PROFILE.memory?.workspace).toBe("from-host");
    expect(CODING_PROFILE.memory?.topics?.map((t) => t.id)).toContain("work/{workspace}/deviation");
    expect(CODING_PROFILE.modules["work-memory"]?.enabled).toBe(true);
    expect(CODING_PROFILE.prompts.system).toContain("<!-- module: work-memory -->");
    expect(CODING_PROFILE.prompts.system).toContain('topic "person/{me}/pref/coding"'); // F3: one path
    expect(CODING_PROFILE.prompts.system).not.toContain('topic "person/{me}/pref",');

    const filled = fillWorkspace(CODING_PROFILE, "billing-v2");
    expect(filled.memory?.workspace).toBe("billing-v2");
    expect(filled.memory?.topics?.map((t) => t.id)).toContain("work/billing-v2/deviation");
    expect(filled.memory?.topics?.map((t) => t.id)).toContain("person/{me}/pref/coding"); // {me} is the service's
    expect(filled.prompts.system).toContain('memory_notes(workspace="billing-v2")');
    expect(filled.prompts.system).not.toContain("{workspace}");
    expect(filled.modules["work-memory"]?.prompt).not.toContain("{workspace}");
    // pure: the builtin is untouched
    expect(CODING_PROFILE.memory?.workspace).toBe("from-host");
    // an explicit workspace on the HOP wins over the host's
    const explicit = fillWorkspace({ ...CODING_PROFILE, memory: { ...CODING_PROFILE.memory!, workspace: "ledger-v2" } }, "other");
    expect(explicit.memory?.workspace).toBe("ledger-v2");
  });
});
