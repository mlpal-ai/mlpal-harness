import { accessSync, constants, existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { BLOCK_ID, HOME_LIMITS, type HopUiView } from "@mlpal/harness-protocol";
import { z } from "zod";

/**
 * W3-1: the `ui` section of hop.yaml, first version (WAVE-3-HOP-SHAPED-HOME §2): starters, and a home of one to four
 * blocks, each fed by one script inside the HOP's directory. Inline, or `ui: file:<relpath>` naming a YAML file of the
 * same shape. It is the HOP's own: a child HOP never inherits its parent's (a parent's scripts are its own files), and
 * it is not a tunable surface. A script path is always relative to the HOP's directory, whichever file declares it.
 */

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const REFRESH = /^(\d{1,4})(m|h)$/;

const plain = (max: number, what: string) =>
  z
    .string()
    .refine((s) => s.trim().length > 0, `${what} is empty`)
    .refine((s) => [...s].length <= max, `${what} is at most ${max} characters`)
    .refine((s) => !CONTROL.test(s), `${what} has a control character`);

function refreshMinutes(s: string): number | null {
  const m = REFRESH.exec(s);
  return m ? Number(m[1]) * (m[2] === "h" ? 60 : 1) : null;
}

const blockSchema = z
  .object({
    id: z.string().regex(BLOCK_ID, "a home block id is lowercase letters, digits and hyphens, starting with a letter, at most 40"),
    title: plain(HOME_LIMITS.titleChars, "a home block title"),
    script: z.string().min(1),
    refresh: z
      .string()
      .refine((s) => {
        const m = refreshMinutes(s);
        return m !== null && m >= HOME_LIMITS.refreshMinMinutes && m <= HOME_LIMITS.refreshMaxMinutes;
      }, `refresh is <n>m or <n>h, from ${HOME_LIMITS.refreshMinMinutes}m to 24h`)
      .default(HOME_LIMITS.refreshDefault),
  })
  .strict();

export const uiSchema = z
  .object({
    starters: z
      .array(plain(HOME_LIMITS.starterChars, "a starter"))
      .max(HOME_LIMITS.starters, `at most ${HOME_LIMITS.starters} starters`)
      .refine((l) => new Set(l).size === l.length, "a starter is listed twice")
      .default([]),
    home: z
      .object({
        blocks: z
          .array(blockSchema)
          .min(1, "a home has at least one block")
          .max(HOME_LIMITS.blocks, `a home has at most ${HOME_LIMITS.blocks} blocks`)
          .refine((bs) => new Set(bs.map((b) => b.id)).size === bs.length, "a home block id is used twice"),
      })
      .strict()
      .optional(),
  })
  .strict();

export type UiSection = z.infer<typeof uiSchema>;

/** What hop.yaml's `ui` key takes: the section inline, or `file:<relpath>`. Not a zod union, whose refusal would say
 *  only "Invalid input": an inline section's faults keep their own paths and messages. */
export const uiFieldSchema = z.unknown().transform((v, ctx): string | UiSection => {
  if (typeof v === "string") {
    if (!v.startsWith("file:")) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "ui is the section itself or file:<relpath>" });
    return v;
  }
  const r = uiSchema.safeParse(v);
  if (r.success) return r.data;
  for (const issue of r.error.issues) ctx.addIssue({ ...issue, code: z.ZodIssueCode.custom, message: issue.message });
  return z.NEVER;
});

export interface HopUiBlock {
  id: string;
  title: string;
  /** As declared: relative to the HOP's directory. */
  script: string;
  /** The script's absolute path (inside the HOP's directory after links). */
  scriptPath: string;
  refresh: string;
  refreshMs: number;
}

/** The composed `ui` of a Profile. */
export interface HopUi {
  starters: string[];
  home?: { blocks: HopUiBlock[] };
}

/** Whether `abs` is strictly inside `root`, by its text and after links (a path that does not resolve: by its text). */
function inside(abs: string, root: string): boolean {
  const within = (p: string, r: string) => {
    const rel = relative(r, p);
    return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
  };
  if (!within(resolve(abs), resolve(root))) return false;
  try {
    return within(realpathSync(abs), realpathSync(root));
  } catch {
    return true;
  }
}

function parseIssue(file: string, e: z.ZodError): Error {
  const first = e.issues[0]!;
  const at = first.path.length ? ` at ui.${first.path.join(".")}` : "";
  return new Error(`${file} is not a valid profile${at}: ${first.message}`);
}

/**
 * The `ui` value as declared (inline or `file:`), parsed and resolved against the HOP's directory `dir`: every script
 * is inside `dir` after links, exists, and is a file the engine can run (a `.py` or `.sh`, or an executable). `confine`
 * (LoadProfileOptions.confineTo) additionally holds a `file:` reference to that root. Throws a load error naming the
 * field.
 */
export function resolveUi(value: string | UiSection, dir: string, confine: (abs: string, field: string) => string): HopUi {
  let section: UiSection;
  if (typeof value === "string") {
    const rel = value.slice("file:".length);
    const abs = confine(isAbsolute(rel) ? rel : join(dir, rel), "ui");
    if (!inside(abs, dir)) throw new Error(`profile ui references ${value}, outside the HOP's directory`);
    if (!existsSync(abs)) throw new Error(`profile ui references ${value} but ${abs} does not exist`);
    let raw: unknown;
    try {
      raw = Bun.YAML.parse(readFileSync(abs, "utf8"));
    } catch (e) {
      throw new Error(`${abs} is not valid YAML: ${(e as Error).message}`);
    }
    const r = uiSchema.safeParse(raw);
    if (!r.success) throw parseIssue(abs, r.error);
    section = r.data;
  } else section = value;
  const blocks = section.home?.blocks.map((b, i): HopUiBlock => {
    const field = `ui.home.blocks[${i}].script`;
    if (isAbsolute(b.script)) throw new Error(`profile ${field} is ${b.script}: a script is a path relative to the HOP's directory`);
    const scriptPath = confine(join(dir, b.script), field);
    if (!inside(scriptPath, dir)) throw new Error(`profile ${field} references ${b.script}, outside the HOP's directory`);
    if (!existsSync(scriptPath) || !statSync(scriptPath).isFile()) throw new Error(`profile ${field} references ${b.script} but ${scriptPath} is not a file`);
    if (!INTERPRETERS[extname(scriptPath)]) {
      try {
        accessSync(scriptPath, constants.X_OK);
      } catch {
        throw new Error(`profile ${field} references ${b.script}, which is neither a .py or .sh file nor executable`);
      }
    }
    return { id: b.id, title: b.title, script: b.script, scriptPath, refresh: b.refresh, refreshMs: refreshMinutes(b.refresh)! * 60_000 };
  });
  return { starters: section.starters, ...(blocks ? { home: { blocks } } : {}) };
}

/** How a script is started, by extension; any other file is run itself. */
const INTERPRETERS: Readonly<Record<string, string>> = { ".py": "python3", ".sh": "/bin/bash" };

const quote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/** The shell line that runs a home script: what the sandbox wraps and what the HOP's deny rules judge. */
export function scriptCommand(scriptPath: string): string {
  const interpreter = INTERPRETERS[extname(scriptPath)];
  return interpreter ? `${interpreter} ${quote(scriptPath)}` : quote(scriptPath);
}

/** `ui` as `describe_hop` carries it. */
export function describeUi(ui: HopUi): HopUiView {
  return {
    starters: [...ui.starters],
    ...(ui.home ? { home: { blocks: ui.home.blocks.map((b) => ({ id: b.id, title: b.title, script: b.script, refresh: b.refresh })) } } : {}),
  };
}
