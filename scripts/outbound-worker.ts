import 'dotenv/config';
import { runWorker } from '../src/lib/workers/runtime';
import { processOutboundJob } from '../src/lib/workers/processors/outbound';
import { MAX_DELIVERY_ATTEMPTS_OUTBOUND } from '../src/lib/workers/retry';

const controller = new AbortController();
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => controller.abort());
}

runWorker({
  queue: 'outbound_jobs',
  process: outboundJobId => processOutboundJob(outboundJobId),
  maxAttempts: MAX_DELIVERY_ATTEMPTS_OUTBOUND,
  signal: controller.signal,
  logger: console,
}).catch(error => {
  console.error('Outbound worker terminated unexpectedly', error);
  process.exitCode = 1;
});
