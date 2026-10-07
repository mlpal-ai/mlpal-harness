import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { z } from "zod";
import { type LspDiagnostic, type LspLocation, type LspPosition, type LspSymbol, pathOf, SYMBOL_KINDS } from "../../lsp/client";
import type { LspManager } from "../../lsp/manager";
import { defineTool, err, ok, resolveInRoots, type Tool } from "../types";

/**
 * Code intelligence through a language server: where a symbol is defined, who references it,
 * what it is, what a file contains, what is wrong with it. The model names a file and either a
 * symbol (the first occurrence in the file is the position) or a line and column; the answers
 * come back as `path:line:col  text` rows the model already knows how to read from Grep.
 */
const schema = z.object({
  action: z.enum(["definition", "references", "hover", "symbols", "diagnostics"]).describe("What to ask: definition (where a symbol is declared), references (every use), hover (type and docs), symbols (the file's outline), diagnostics (the server's errors and warnings for the file)."),
  path: z.string().describe("The file, relative to the working directory or absolute."),
  symbol: z.string().optional().describe("For definition/references/hover: the identifier to look at; its first occurrence in the file after `line` (if given) is the position."),
  line: z.number().int().positive().optional().describe("1-based line of the position (with `column`), or where the search for `symbol` starts."),
  column: z.number().int().positive().optional().describe("1-based column of the position; needs `line`."),
  includeDeclaration: z.boolean().optional().describe("references: include the declaration itself (default true)."),
});
export type LspToolInput = z.infer<typeof schema>;

const MAX_ROWS = 60;
/** variable, constant, property, field, object: their children are not outline entries. */
const VALUE_KINDS = new Set([13, 14, 7, 8, 19]);
const SEVERITY: Record<number, string> = { 1: "error", 2: "warning", 3: "info", 4: "hint" };

/** The position of a symbol's first occurrence as a whole word, at or after `fromLine` (0-based). */
export function positionOfSymbol(text: string, symbol: string, fromLine = 0): LspPosition | null {
  const re = new RegExp(`(?<![\\w$])${symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w$])`);
  const lines = text.split("\n");
  for (let i = fromLine; i < lines.length; i++) {
    const m = re.exec(lines[i]!);
    if (m) return { line: i, character: m.index };
  }
  return null;
}

function lineText(cache: Map<string, string[]>, path: string, line: number): string {
  if (!cache.has(path)) {
    try {
      cache.set(path, readFileSync(path, "utf8").split("\n"));
    } catch {
      cache.set(path, []);
    }
  }
  return (cache.get(path)![line] ?? "").trim();
}

export function renderLocations(locs: LspLocation[], cwd: string): string {
  const cache = new Map<string, string[]>();
  const rows = locs.slice(0, MAX_ROWS).map((l) => {
    const p = pathOf(l.uri);
    return `${relative(cwd, p) || p}:${l.range.start.line + 1}:${l.range.start.character + 1}  ${lineText(cache, p, l.range.start.line)}`;
  });
  const more = locs.length > MAX_ROWS ? `\n… ${locs.length - MAX_ROWS} more` : "";
  return rows.join("\n") + more;
}

export function renderSymbols(symbols: LspSymbol[], depth = 0): string[] {
  const out: string[] = [];
  for (const s of symbols) {
    const range = s.selectionRange ?? s.range ?? s.location?.range;
    const line = range ? `:${range.start.line + 1}` : "";
    out.push(`${"  ".repeat(depth)}${SYMBOL_KINDS[s.kind] ?? "symbol"} ${s.name}${line}${s.containerName ? `  (in ${s.containerName})` : ""}`);
    // The members of a value (an object literal's keys, a constant's fields) are noise in an
    // outline; the members of a type (a class's methods, an interface's fields) are the outline.
    if (s.children?.length && !VALUE_KINDS.has(s.kind)) out.push(...renderSymbols(s.children, depth + 1));
  }
  return out;
}

export function renderDiagnostics(d: LspDiagnostic[], path: string, cwd: string): string {
  if (d.length === 0) return `no diagnostics for ${relative(cwd, path) || path}`;
  const rel = relative(cwd, path) || path;
  return d.slice(0, MAX_ROWS).map((x) => `${rel}:${x.range.start.line + 1}:${x.range.start.character + 1}  ${SEVERITY[x.severity ?? 1] ?? "error"}${x.code !== undefined ? ` ${x.code}` : ""}: ${x.message.split("\n")[0]}`).join("\n") + (d.length > MAX_ROWS ? `\n… ${d.length - MAX_ROWS} more` : "");
}

export function createLspTool(manager: LspManager): Tool<LspToolInput> {
  return defineTool<LspToolInput>({
    name: "Lsp",
    description: `Code intelligence from a language server (${manager.languages().join(", ") || "none configured"}): go to a symbol's definition, list its references, read its type and docs (hover), outline a file (symbols), or get the server's diagnostics for a file. Prefer this over Grep when the question is about one identifier: it understands scope, imports and types. Name the file plus a symbol, or a line and column.`,
    readOnly: true,
    schema,
    async call(input, ctx) {
      const r = resolveInRoots(ctx, input.path);
      if ("error" in r) return r.error;
      const path = r.path;
      const res = await manager.clientFor(path, ctx.cwd);
      if (!res.ok) return err(`Lsp: ${res.reason}`);
      const { client, languageId } = res;
      let uri: string;
      try {
        uri = client.open(path, languageId);
      } catch (e) {
        return err(`Lsp: cannot read ${input.path}: ${String((e as Error)?.message ?? e)}`);
      }
      const needsPosition = input.action === "definition" || input.action === "references" || input.action === "hover";
      let position: LspPosition | null = null;
      if (needsPosition) {
        if (input.symbol) {
          position = positionOfSymbol(readFileSync(path, "utf8"), input.symbol, input.line ? input.line - 1 : 0);
          if (!position) return err(`Lsp: "${input.symbol}" does not occur in ${input.path}${input.line ? ` at or after line ${input.line}` : ""}`);
        } else if (input.line && input.column) {
          position = { line: input.line - 1, character: input.column - 1 };
        } else {
          return err("Lsp: definition, references and hover need `symbol`, or `line` and `column`");
        }
      }
      try {
        switch (input.action) {
          case "definition": {
            const locs = await client.definition(uri, position!);
            return ok(locs.length ? renderLocations(locs, ctx.cwd) : "no definition found");
          }
          case "references": {
            const locs = await client.references(uri, position!, input.includeDeclaration ?? true);
            return ok(locs.length ? `${locs.length} reference${locs.length === 1 ? "" : "s"}\n${renderLocations(locs, ctx.cwd)}` : "no references found");
          }
          case "hover": {
            const text = await client.hover(uri, position!);
            return ok(text ?? "no hover information");
          }
          case "symbols": {
            const rows = renderSymbols(await client.documentSymbols(uri));
            return ok(rows.length ? rows.slice(0, 200).join("\n") + (rows.length > 200 ? `\n… ${rows.length - 200} more` : "") : "no symbols");
          }
          case "diagnostics":
            return ok(renderDiagnostics(await client.diagnosticsFor(uri), path, ctx.cwd));
        }
      } catch (e) {
        return err(`Lsp: ${String((e as Error)?.message ?? e)}`);
      }
    },
  });
}
