import { describe, expect, it, vi } from 'vitest';
import { CustomerIdentityService } from '../customer-identity';

describe('CustomerIdentityService', () => {
  it('uses a connection-scoped database API without accepting a workspace', async () => {
    const customer = { id: 'customer-1', workspace_id: 'derived', connection_id: 'connection-1', provider_user_id: 'user-1' };
    const client = { query: vi.fn().mockResolvedValue({ rows: [customer] }) };

    await expect(CustomerIdentityService.upsert({
      connectionId: 'connection-1', provider: 'telegram', providerUserId: ' user-1 ', fullName: 'Ada', username: 'ada',
    }, client)).resolves.toEqual(customer);
    expect(client.query).toHaveBeenCalledWith(
      'SELECT * FROM upsert_connection_customer($1, $2, $3, $4, $5)',
      ['connection-1', 'telegram', 'user-1', 'Ada', 'ada'],
    );
  });

  it('rejects an empty provider identity before querying', async () => {
    const client = { query: vi.fn() };
    await expect(CustomerIdentityService.upsert({
      connectionId: 'connection-1', provider: 'instagram', providerUserId: '  ',
    }, client)).rejects.toThrow('connectionId and providerUserId are required');
    expect(client.query).not.toHaveBeenCalled();
  });
});
