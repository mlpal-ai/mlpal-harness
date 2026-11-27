import { DISPLAY_LIMITS } from "./catalog.js";
import { fail } from "./errors.js";

type Path = ReadonlyArray<string | number>;

interface Frame {
  value: unknown;
  depth: number;
  parent: Frame | null;
  key: string | number | null;
}

function segments(f: Frame): Array<string | number> {
  const out: Array<string | number> = [];
  for (let at: Frame | null = f; at && at.key !== null; at = at.parent) out.push(at.key);
  return out.reverse();
}

/**
 * A model-written value must fit before anything walks it recursively or serialises it: at most 32 levels deep and
 * 100,000 values (every object, array and scalar counts one). Checked with an explicit stack, so no input can overflow
 * the call stack here; the path of an offending value is built only when it is refused. Every recursive check after
 * this one is bounded by it. The same walk refuses the keys `__proto__`, `constructor` and `prototype` anywhere, data
 * rows included.
 */
/** Names that change an object's prototype or its constructor when a consumer assigns them: never a key. */
const RESERVED: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

export function checkBounds(value: unknown, path: Path): void {
  const stack: Frame[] = [{ value, depth: 0, parent: null, key: null }];
  let nodes = 0;
  while (stack.length > 0) {
    const f = stack.pop()!;
    if (++nodes > DISPLAY_LIMITS.inputNodes) fail("SPEC_TOO_LARGE", path, `over ${DISPLAY_LIMITS.inputNodes} values`, "aggregate the data, or show fewer rows and give the total in the fallback");
    if (f.depth > DISPLAY_LIMITS.inputDepth) fail("SPEC_TOO_LARGE", [...path, ...segments(f)], `nested over ${DISPLAY_LIMITS.inputDepth} levels deep`, "flatten the structure");
    const v = f.value;
    if (Array.isArray(v)) {
      for (let i = v.length - 1; i >= 0; i--) stack.push({ value: v[i], depth: f.depth + 1, parent: f, key: i });
    } else if (typeof v === "object" && v !== null) {
      const keys = Object.keys(v);
      for (const k of keys) if (RESERVED.has(k)) fail("VALIDATION_FAILED", [...path, ...segments(f), k], `"${k}" is a reserved name and never a key`, "rename the field");
      for (let i = keys.length - 1; i >= 0; i--) stack.push({ value: (v as Record<string, unknown>)[keys[i]!], depth: f.depth + 1, parent: f, key: keys[i]! });
    }
  }
}
