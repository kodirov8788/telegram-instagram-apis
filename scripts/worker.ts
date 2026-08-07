import 'dotenv/config';
import { runWorker } from '../src/lib/workers/runtime';
import { processInboundEvent } from '../src/lib/workers/processors/inbound';

const controller = new AbortController();
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => controller.abort());
}

runWorker({
  queue: 'inbound_events',
  process: providerEventId => processInboundEvent(providerEventId),
  signal: controller.signal,
  logger: console,
}).catch(error => {
  console.error('Inbound worker terminated unexpectedly', error);
  process.exitCode = 1;
});
