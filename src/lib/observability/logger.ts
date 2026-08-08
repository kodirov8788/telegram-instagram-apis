/**
 * Structured logging helper for worker/queue log lines (issue #48).
 *
 * Scope: this replaces ad-hoc `console.log`/`console.error` string
 * messages with consistent single-line JSON, so log lines can be grepped/
 * parsed uniformly. It intentionally does NOT introduce a new correlation
 * id generator — callers pass the id that's already flowing through the
 * pipeline (a `provider_events.id` for inbound, an `outbound_jobs.id` for
 * outbound) as `correlationId`.
 *
 * The returned logger's `info`/`error` signature — `(message, fields?)` —
 * matches `Pick<Console, 'info' | 'error'>`, so it's a drop-in replacement
 * anywhere `logger: console` is passed today (see `runtime.ts`'s
 * `WorkerRuntimeOptions.logger`).
 */

export type LogFields = Record<string, unknown>;

export interface StructuredLogger {
  info(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

function serialize(level: 'info' | 'error', component: string, message: string, fields?: LogFields): string {
  return JSON.stringify({
    ts: new Date().toISOString(),
    level,
    component,
    message,
    ...fields,
  });
}

/**
 * Builds a logger that tags every line with `component` (e.g.
 * 'inbound-worker', 'outbound-worker') and emits one JSON object per line
 * to stdout (info) / stderr (error) — no external transport, no
 * dependency, matches the rest of this repo's plain-`console` logging.
 */
export function createLogger(component: string): StructuredLogger {
  return {
    info(message: string, fields?: LogFields) {
      console.log(serialize('info', component, message, fields));
    },
    error(message: string, fields?: LogFields) {
      console.error(serialize('error', component, message, fields));
    },
  };
}
