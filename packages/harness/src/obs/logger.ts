/**
 * Structured logging. JSON lines with stable fields + correlation context (runId,
 * sessionId, agentId) carried by child loggers — debuggable from a log pipeline, no
 * SSH required (the CLAUDE.md bar). Logs go to a sink (stderr by default) so they
 * never corrupt the SDKMessage stream on stdout. Library default is silent; the host
 * (CLI / server) opts in to a level.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export type LogFields = Record<string, unknown>;

export interface Logger {
  child(fields: LogFields): Logger;
  log(level: LogLevel, msg: string, fields?: LogFields): void;
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
}

export type LogSink = (line: string) => void;

const stderrSink: LogSink = (line) => process.stderr.write(`${line}\n`);

export interface JsonLoggerOptions {
  level?: LogLevel;
  sink?: LogSink;
  base?: LogFields;
  /** Injected for deterministic tests; defaults to wall clock. */
  now?: () => string;
}

export class JsonLogger implements Logger {
  private readonly minLevel: number;
  private readonly sink: LogSink;
  private readonly base: LogFields;
  private readonly now: () => string;

  constructor(opts: JsonLoggerOptions = {}) {
    this.minLevel = LEVEL_ORDER[opts.level ?? "info"];
    this.sink = opts.sink ?? stderrSink;
    this.base = opts.base ?? {};
    this.now = opts.now ?? (() => new Date().toISOString());
  }

  child(fields: LogFields): Logger {
    const child = Object.create(JsonLogger.prototype) as JsonLogger;
    // share config, extend base — avoids re-resolving level/sink
    Object.assign(child, {
      minLevel: this.minLevel,
      sink: this.sink,
      base: { ...this.base, ...fields },
      now: this.now,
    });
    return child;
  }

  log(level: LogLevel, msg: string, fields?: LogFields): void {
    if (LEVEL_ORDER[level] < this.minLevel) return;
    const record = { ts: this.now(), level, msg, ...this.base, ...fields };
    this.sink(JSON.stringify(record));
  }

  debug(msg: string, fields?: LogFields): void {
    this.log("debug", msg, fields);
  }
  info(msg: string, fields?: LogFields): void {
    this.log("info", msg, fields);
  }
  warn(msg: string, fields?: LogFields): void {
    this.log("warn", msg, fields);
  }
  error(msg: string, fields?: LogFields): void {
    this.log("error", msg, fields);
  }
}

/** No-op logger — the default for library use and tests. */
export const silentLogger: Logger = {
  child() {
    return silentLogger;
  },
  log() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
};
