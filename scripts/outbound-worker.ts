import 'dotenv/config';
import { runWorker } from '../src/lib/workers/runtime';
import { processOutboundJob } from '../src/lib/workers/processors/outbound';
import { MAX_DELIVERY_ATTEMPTS_OUTBOUND } from '../src/lib/workers/retry';
import { createLogger } from '../src/lib/observability/logger';

const logger = createLogger('outbound-worker');
const controller = new AbortController();
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => controller.abort());
}

// See scripts/worker.ts for why this is a log-line heartbeat rather than
// an HTTP healthcheck (issue #48).
const HEARTBEAT_INTERVAL_MS = 30_000;
const heartbeat = setInterval(() => {
  logger.info('Worker heartbeat', { queue: 'outbound_jobs' });
}, HEARTBEAT_INTERVAL_MS);
heartbeat.unref();
controller.signal.addEventListener('abort', () => clearInterval(heartbeat), { once: true });

runWorker({
  queue: 'outbound_jobs',
  process: outboundJobId => processOutboundJob(outboundJobId),
  maxAttempts: MAX_DELIVERY_ATTEMPTS_OUTBOUND,
  signal: controller.signal,
  logger,
}).catch(error => {
  logger.error('Outbound worker terminated unexpectedly', { error: String(error?.message ?? error) });
  process.exitCode = 1;
});
