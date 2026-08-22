/**
 * Per-subtask model routing — yodex's "right model for the job" lever (and a key edge
 * over single-model harnesses). Roles map to concrete model tags; cheaper roles fall
 * back sensibly toward the main model. Meta-models are resolved to concrete tags by the
 * host before constructing the router, so this stays pure. See docs/05 §6.
 */

export type ModelRole = "main" | "summarize" | "subagent" | "classify";

/**
 * The routing spec for subtask roles (sub-agents, summaries, classifiers). Honor an explicit
 * config value; otherwise default to the cheap tier when the main model was NOT pinned (cost-
 * optimized — "save me money"), or "inherit" (the main model) when it was ("use the model I
 * asked for"). Returned spec is a tier alias, a concrete model id, or "inherit".
 */
export function subtaskSpec(configured: string | undefined, mainPinned: boolean): string {
  return configured ?? (mainPinned ? "inherit" : "cheap");
}

export interface RoutingConfig {
  main: string;
  /** Compaction summaries — typically a fast/cheap tier. */
  summarize?: string;
  /** Spawned sub-agents / verifiers. */
  subagent?: string;
  /** Cheap classifiers / title generation. */
  classify?: string;
}

export class ModelRouter {
  constructor(private readonly cfg: RoutingConfig) {}

  get main(): string {
    return this.cfg.main;
  }

  resolve(role: ModelRole): string {
    switch (role) {
      case "summarize":
        return this.cfg.summarize ?? this.cfg.classify ?? this.cfg.main;
      case "classify":
        return this.cfg.classify ?? this.cfg.summarize ?? this.cfg.main;
      case "subagent":
        return this.cfg.subagent ?? this.cfg.main;
      default:
        return this.cfg.main;
    }
  }
}
