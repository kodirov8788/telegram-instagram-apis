import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLogger } from '../logger';

describe('createLogger', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('emits info lines as a single JSON object to console.log', () => {
    const logger = createLogger('inbound-worker');
    logger.info('Worker heartbeat', { queue: 'inbound_events' });

    expect(logSpy).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(logSpy.mock.calls[0][0]);
    expect(parsed).toMatchObject({
      level: 'info',
      component: 'inbound-worker',
      message: 'Worker heartbeat',
      queue: 'inbound_events',
    });
    expect(typeof parsed.ts).toBe('string');
    expect(() => new Date(parsed.ts).toISOString()).not.toThrow();
  });

  it('emits error lines as a single JSON object to console.error', () => {
    const logger = createLogger('outbound-worker');
    logger.error('Archived queue message after maximum attempts', {
      queue: 'outbound_jobs',
      messageId: '42',
      correlationId: 'job-1',
      attempts: 8,
    });

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(errorSpy.mock.calls[0][0]);
    expect(parsed).toMatchObject({
      level: 'error',
      component: 'outbound-worker',
      message: 'Archived queue message after maximum attempts',
      queue: 'outbound_jobs',
      messageId: '42',
      correlationId: 'job-1',
      attempts: 8,
    });
  });

  it('works fine with no fields at all', () => {
    const logger = createLogger('test');
    expect(() => logger.info('hello')).not.toThrow();
    const parsed = JSON.parse(logSpy.mock.calls[0][0]);
    expect(parsed.message).toBe('hello');
  });

  it('is structurally compatible with Pick<Console, "info" | "error">', () => {
    // runWorker/processWorkerBatch accept `logger?: Pick<Console, 'info' | 'error'>`
    // — this is the drop-in-replacement contract the worker scripts rely on.
    const consoleLike: Pick<Console, 'info' | 'error'> = createLogger('compat-check');
    expect(consoleLike).toBeDefined();
  });
});
