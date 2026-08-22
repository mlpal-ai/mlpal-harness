/**
 * Lenient JSON for LLM tool-call payloads.
 *
 * Models routinely hand a *string* where a structured field belongs — and the string is often
 * not quite JSON: single quotes, smart quotes, unquoted keys, trailing commas, literal
 * newlines inside strings, Python literals (True/None), markdown fences, a sentence of prose
 * before the value, or unescaped inner quotes once descriptions carry natural language.
 * Rejecting those burns a whole model turn per retry (observed repeatedly in production).
 *
 * Strategy: strict JSON.parse first — it is the contract and the fast path. Only on failure
 * run a small tolerant reader over the known malformation classes. The reader is FAIL-SAFE by
 * construction: every heuristic either produces a well-formed value or throws (returning
 * ok:false so the caller surfaces the original validation error) — it never silently guesses
 * a wrong-but-valid structure past ambiguity it can't resolve.
 */

export type LenientResult = { ok: true; value: unknown } | { ok: false; error: string };

/**
 * Marker key for tool inputs whose JSON could not be parsed AT ALL (even leniently). The
 * gateway plants it instead of silently degrading to `{}` — which used to turn a malformed
 * tool call into a "successful" call with empty input and a baffling "field required" error.
 * The registry intercepts it before validation and tells the model exactly what it sent.
 */
export const MALFORMED_INPUT_KEY = "__yodex_malformed_json__";

export function parseJsonLenient(raw: string): LenientResult {
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    /* fall through to the tolerant reader */
  }
  let s = raw.trim();
  // Markdown fences: ```json ... ``` (models love wrapping payloads).
  const fence = /^```[a-zA-Z]*\s*\n?([\s\S]*?)\n?```\s*$/.exec(s);
  if (fence) s = fence[1]!.trim();
  // Leading prose ("Here are the questions: [...]") — start at the first structural opener.
  const start = s.search(/[[{]/);
  if (start < 0) return { ok: false, error: "no JSON value found" };
  try {
    const p = new Lenient(s, start);
    const value = p.value();
    return { ok: true, value };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Openers → the smart-quote closers that may pair with them (straight quote always accepted). */
const SMART_CLOSERS: Record<string, string> = { "“": "”", "‘": "’" };
/** Characters that legitimately follow a closed string — the disambiguator for inner quotes. */
const AFTER_STRING = new Set([",", ":", "]", "}", ""]);

class Lenient {
  constructor(
    private readonly s: string,
    private pos: number,
  ) {}

  private peek(): string {
    return this.s[this.pos] ?? "";
  }

  private next(): string {
    return this.s[this.pos++] ?? "";
  }

  private fail(msg: string): never {
    throw new Error(`${msg} at ${this.pos}`);
  }

  /** Skip whitespace and // or C-style comments (models occasionally annotate payloads). */
  private ws(): void {
    for (;;) {
      while (/\s/.test(this.peek())) this.pos++;
      if (this.s.startsWith("//", this.pos)) {
        while (this.pos < this.s.length && this.peek() !== "\n") this.pos++;
        continue;
      }
      if (this.s.startsWith("/*", this.pos)) {
        const end = this.s.indexOf("*/", this.pos + 2);
        if (end < 0) this.fail("unterminated comment");
        this.pos = end + 2;
        continue;
      }
      return;
    }
  }

  value(): unknown {
    this.ws();
    const c = this.peek();
    if (c === "{") return this.object();
    if (c === "[") return this.array();
    if (c === '"' || c === "'" || c in SMART_CLOSERS) return this.string(this.next());
    return this.bare();
  }

  private object(): Record<string, unknown> {
    this.pos++; // {
    const out: Record<string, unknown> = {};
    this.ws();
    if (this.peek() === "}") {
      this.pos++;
      return out;
    }
    for (;;) {
      this.ws();
      const key = this.key();
      this.ws();
      if (this.next() !== ":") this.fail("expected ':'");
      out[key] = this.value();
      this.ws();
      const d = this.next();
      if (d === ",") {
        this.ws();
        if (this.peek() === "}") {
          this.pos++;
          return out; // trailing comma
        }
        continue;
      }
      if (d === "}") return out;
      this.fail("expected ',' or '}'");
    }
  }

  private array(): unknown[] {
    this.pos++; // [
    const out: unknown[] = [];
    this.ws();
    if (this.peek() === "]") {
      this.pos++;
      return out;
    }
    for (;;) {
      out.push(this.value());
      this.ws();
      const d = this.next();
      if (d === ",") {
        this.ws();
        if (this.peek() === "]") {
          this.pos++;
          return out; // trailing comma
        }
        continue;
      }
      if (d === "]") return out;
      this.fail("expected ',' or ']'");
    }
  }

  private key(): string {
    const c = this.peek();
    if (c === '"' || c === "'" || c in SMART_CLOSERS) return this.string(this.next());
    // Unquoted identifier key: {question: "..."}.
    const m = /^[A-Za-z_$][\w$]*/.exec(this.s.slice(this.pos));
    if (!m) this.fail("expected object key");
    this.pos += m[0].length;
    return m[0];
  }

  /**
   * Read a string opened by `open`. Tolerates literal newlines/tabs and unknown escapes.
   * The inner-quote heuristic: an unescaped closing quote only CLOSES the string when the next
   * non-space character is structural (, : ] } or end) — otherwise it's content ("a "big" deal").
   * When the heuristic closes too early on adversarial input, the parser then hits a
   * non-structural character and throws — fail-safe, never a silently wrong value.
   */
  private string(open: string): string {
    const closers = new Set([open === "“" || open === "‘" ? SMART_CLOSERS[open]! : open, '"']);
    if (open === "'") closers.add("'");
    let out = "";
    for (;;) {
      if (this.pos >= this.s.length) this.fail("unterminated string");
      const c = this.next();
      if (c === "\\") {
        const e = this.next();
        if (e === "n") out += "\n";
        else if (e === "t") out += "\t";
        else if (e === "r") out += "\r";
        else if (e === "u") {
          const hex = this.s.slice(this.pos, this.pos + 4);
          if (/^[0-9a-fA-F]{4}$/.test(hex)) {
            out += String.fromCharCode(Number.parseInt(hex, 16));
            this.pos += 4;
          } else out += "u";
        } else out += e; // \" \\ \/ and any unknown escape → the character itself
        continue;
      }
      if (closers.has(c)) {
        // Peek past spaces (NOT newlines — a quote at end-of-line inside prose stays content
        // only if something non-structural follows; end-of-input counts as structural).
        let i = this.pos;
        while (i < this.s.length && (this.s[i] === " " || this.s[i] === "\t")) i++;
        const nextCh = i < this.s.length ? this.s[i]! : "";
        if (AFTER_STRING.has(nextCh) || nextCh === "\n" || nextCh === "\r") return out;
        out += c; // interior quote — content, not a terminator
        continue;
      }
      out += c; // includes literal newlines/tabs, which strict JSON forbids
    }
  }

  /** Bare tokens: numbers, booleans/null (JSON or Python spelling). Anything else fails. */
  private bare(): unknown {
    const m = /^[^\s,\]}]+/.exec(this.s.slice(this.pos));
    if (!m) this.fail("expected value");
    const tok = m[0];
    this.pos += tok.length;
    if (tok === "true" || tok === "True") return true;
    if (tok === "false" || tok === "False") return false;
    if (tok === "null" || tok === "None" || tok === "undefined") return null;
    if (/^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/.test(tok)) return Number(tok);
    this.fail(`unexpected token '${tok.slice(0, 20)}'`);
  }
}
