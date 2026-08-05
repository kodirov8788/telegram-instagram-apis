import { runWorker } from '../src/lib/workers/runtime';
// The processor module is supplied by the processing layer; this entrypoint owns
// only queue lifecycle and dispatch.
// @ts-ignore -- processors are integrated as a separate runtime component.
import { processInboundEvent, processOutboundJob } from '../src/lib/workers/processors';

const controller = new AbortController();
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => controller.abort());
}

const queue = process.argv[2];
if (queue !== 'inbound_events' && queue !== 'outbound_messages') {
  throw new Error('Usage: npm run worker -- inbound_events|outbound_messages');
}

const processMessage = queue === 'inbound_events' ? processInboundEvent : processOutboundJob;
runWorker({ queue, process: processMessage, signal: controller.signal, logger: console })
  .catch(() => {
    console.error('Worker terminated unexpectedly', { queue });
    process.exitCode = 1;
  });
