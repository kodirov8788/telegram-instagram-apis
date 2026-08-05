import { describe, expect, it, vi } from 'vitest';
import { processInboundEvent } from '../processors/inbound';

describe('processInboundEvent', () => {
  it('releases the claim transaction before intelligence work and finalizes failures safely', async () => {
    const order: string[] = [];
    let transactionNumber = 0;
    const transaction = async <T>(operation: (db: any) => Promise<T>) => {
      const current = ++transactionNumber;
      order.push(`tx${current}:begin`);
      const result = await operation({ query: vi.fn(async (text: string) => {
        if (text.includes("status = 'processing'")) return { rows: [{
          id: 'event', workspace_id: 'workspace', connection_id: 'connection', provider: 'telegram', attempts: 1,
          payload: { update_id: 1, message: { message_id: 2, from: { id: 3, is_bot: false, first_name: 'Ada' }, chat: { id: 3, type: 'private' }, date: 1, text: 'hello' } },
        }] };
        return { rows: [] };
      }) });
      order.push(`tx${current}:commit`);
      return result;
    };
    const analyze = vi.fn(async () => {
      order.push('analyze');
      throw new Error('sensitive upstream response');
    });

    await expect(processInboundEvent('event', { transaction, analyze })).rejects.toThrow('retryable');
    expect(order).toEqual(['tx1:begin', 'tx1:commit', 'analyze', 'tx2:begin', 'tx2:commit']);
  });
});
