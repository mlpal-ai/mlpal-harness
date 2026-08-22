/**
 * A compact unified-diff generator for the Write/Edit tools. Produces a git-style single-hunk
 * patch (`@@ -a,b +c,d @@` then ` `/`-`/`+` lines) from before/after file text, for rich diff
 * rendering in frontends (web/VS Code chat cards). This is render-only — it rides on the
 * ToolResultEvent, never into the model's context. The terminal TUI has its own ANSI renderer
 * (cli/diff.ts); this one emits plain patch text that any client can parse.
 *
 * Single-hunk (common prefix/suffix trim) keeps it cheap and predictable; scattered edits
 * collapse into one hunk, which is fine for a summary card. Output is capped so a huge rewrite
 * can't produce an unbounded event.
 */

const MAX_LINES = 240;

export function unifiedDiff(before: string, after: string, context = 3): string {
  if (before === after) return "";
  const oldLines = before.length ? before.split("\n") : [];
  const newLines = after.length ? after.split("\n") : [];

  let p = 0;
  while (p < oldLines.length && p < newLines.length && oldLines[p] === newLines[p]) p++;
  let s = 0;
  while (
    s < oldLines.length - p &&
    s < newLines.length - p &&
    oldLines[oldLines.length - 1 - s] === newLines[newLines.length - 1 - s]
  )
    s++;

  const removed = oldLines.slice(p, oldLines.length - s);
  const added = newLines.slice(p, newLines.length - s);
  if (removed.length === 0 && added.length === 0) return "";

  const ctxStart = Math.max(0, p - context);
  const lead: string[] = [];
  for (let i = ctxStart; i < p; i++) lead.push(" " + oldLines[i]);
  const mid: string[] = [
    ...removed.map((l) => "-" + l),
    ...added.map((l) => "+" + l),
  ];
  const tailOld = oldLines.length - s;
  const tailNew = newLines.length - s;
  const trail: string[] = [];
  for (let i = 0; i < context && tailOld + i < oldLines.length; i++) trail.push(" " + oldLines[tailOld + i]);

  const leadCount = p - ctxStart;
  const oldCount = leadCount + removed.length + trail.length;
  const newCount = leadCount + added.length + trail.length;
  const header = `@@ -${ctxStart + 1},${oldCount} +${ctxStart + 1},${newCount} @@`;

  let body = [...lead, ...mid, ...trail];
  if (body.length > MAX_LINES) {
    const kept = body.length - MAX_LINES;
    body = body.slice(0, MAX_LINES);
    body.push(` … ${kept} more line(s)`);
  }
  return [header, ...body].join("\n");
}
