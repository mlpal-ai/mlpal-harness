/**
 * E3: a block whose latest envelope is `repairing` when its run ends was never repaired. An engine from this version
 * settles it on the run's result (`ResultEvent.display`, `fallback_only`); a session written before reads the same way
 * through this function. Pure: the messages come back with those envelopes' status set to `fallback_only`, as
 * copies; anything else is unchanged.
 */
type Msg = { type: string; display?: unknown };
type Env = { block_id: string; status?: string };

export function settleDisplays<T extends Msg>(messages: readonly T[]): T[] {
  /** Per block, where its latest envelope is: [message index, envelope index]. */
  const latest = new Map<string, [number, number]>();
  const settle = new Set<string>();
  messages.forEach((m, i) => {
    if (Array.isArray(m.display)) (m.display as Env[]).forEach((d, j) => latest.set(d.block_id, [i, j]));
    if (m.type !== "result") return;
    for (const [i2, j2] of latest.values()) {
      const d = (messages[i2]!.display as Env[])[j2]!;
      if (d.status === "repairing") settle.add(`${i2}:${j2}`);
    }
  });
  if (settle.size === 0) return [...messages];
  return messages.map((m, i) => {
    if (!Array.isArray(m.display) || !(m.display as Env[]).some((_, j) => settle.has(`${i}:${j}`))) return m;
    return { ...m, display: (m.display as Env[]).map((d, j) => (settle.has(`${i}:${j}`) ? { ...d, status: "fallback_only" } : d)) };
  });
}
