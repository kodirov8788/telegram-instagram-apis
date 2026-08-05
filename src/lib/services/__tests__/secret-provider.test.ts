import { describe, expect, it, vi } from 'vitest';
import { DatabaseSecretProvider } from '../secret-provider';

describe('DatabaseSecretProvider', () => {
  it('scopes lookup to workspace, connection, and provider', async () => {
    const db = { query: vi.fn().mockResolvedValue({ rows: [{ credentials: { bot_token: 'token' } }] }) };
    const transaction = async <T>(operation: (client: typeof db) => Promise<T>) => operation(db);
    const provider = new DatabaseSecretProvider(transaction);
    await expect(provider.getConnectionSecret({ connectionId: 'c', workspaceId: 'w', provider: 'telegram' })).resolves.toEqual({ accessToken: 'token' });
    expect(db.query.mock.calls[0][1]).toEqual(['c', 'w', 'telegram']);
  });

  it('dereferences optional vault credentials', async () => {
    const db = { query: vi.fn().mockResolvedValue({ rows: [{ credentials: { vault_ref: 'channels/c' } }] }) };
    const vault = { read: vi.fn().mockResolvedValue({ access_token: 'vault-token' }) };
    const transaction = async <T>(operation: (client: typeof db) => Promise<T>) => operation(db);
    await expect(new DatabaseSecretProvider(transaction, vault).getConnectionSecret({ connectionId: 'c', workspaceId: 'w', provider: 'instagram' })).resolves.toEqual({ accessToken: 'vault-token' });
    expect(vault.read).toHaveBeenCalledWith('channels/c');
  });
});
