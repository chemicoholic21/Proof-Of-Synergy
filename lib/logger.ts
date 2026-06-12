/**
 * Minimal structured logger.
 *
 * Emits single-line JSON so logs are machine-parseable by any aggregator (Datadog, Loki,
 * CloudWatch, Vercel) without a heavy dependency. Each log line carries a level, message,
 * timestamp and arbitrary structured context. Attach a `requestId` to correlate a request's
 * lifecycle across log lines.
 */

type Level = "debug" | "info" | "warn" | "error";

type Context = Record<string, unknown>;

function emit(level: Level, message: string, context?: Context) {
  const line: Record<string, unknown> = {
    level,
    msg: message,
    time: new Date().toISOString(),
    ...context,
  };
  // Serialize Errors usefully instead of "{}".
  for (const [k, v] of Object.entries(line)) {
    if (v instanceof Error) line[k] = { name: v.name, message: v.message, stack: v.stack };
  }
  const out = JSON.stringify(line);
  if (level === "error") console.error(out);
  else if (level === "warn") console.warn(out);
  else console.log(out);
}

export const logger = {
  debug: (msg: string, ctx?: Context) => emit("debug", msg, ctx),
  info: (msg: string, ctx?: Context) => emit("info", msg, ctx),
  warn: (msg: string, ctx?: Context) => emit("warn", msg, ctx),
  error: (msg: string, ctx?: Context) => emit("error", msg, ctx),
  /** Returns a child logger that includes the given context on every line. */
  child(base: Context) {
    return {
      debug: (msg: string, ctx?: Context) => emit("debug", msg, { ...base, ...ctx }),
      info: (msg: string, ctx?: Context) => emit("info", msg, { ...base, ...ctx }),
      warn: (msg: string, ctx?: Context) => emit("warn", msg, { ...base, ...ctx }),
      error: (msg: string, ctx?: Context) => emit("error", msg, { ...base, ...ctx }),
    };
  },
};

export type Logger = ReturnType<typeof logger.child>;
