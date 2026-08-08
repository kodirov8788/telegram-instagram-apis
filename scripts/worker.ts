import 'dotenv/config';
import { runWorker } from '../src/lib/workers/runtime';
import { processInboundEvent } from '../src/lib/workers/processors/inbound';
import { createLogger } from '../src/lib/observability/logger';

const logger = createLogger('inbound-worker');
const controller = new AbortController();
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => controller.abort());
}

// Periodic liveness signal for this long-running process — see issue #48:
// there's no HTTP surface on the worker itself to health-check, so a
// heartbeat log line is the bounded "is this process alive" story here.
const HEARTBEAT_INTERVAL_MS = 30_000;
const heartbeat = setInterval(() => {
  logger.info('Worker heartbeat', { queue: 'inbound_events' });
}, HEARTBEAT_INTERVAL_MS);
heartbeat.unref();
controller.signal.addEventListener('abort', () => clearInterval(heartbeat), { once: true });

runWorker({
  queue: 'inbound_events',
  process: providerEventId => processInboundEvent(providerEventId),
  signal: controller.signal,
  logger,
}).catch(error => {
  logger.error('Inbound worker terminated unexpectedly', { error: String(error?.message ?? error) });
  process.exitCode = 1;
});
