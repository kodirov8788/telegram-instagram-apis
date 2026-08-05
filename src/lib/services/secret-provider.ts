import type { TransactionRunner } from '../workers/transaction';

export type Provider = 'telegram' | 'instagram';

export interface ConnectionSecret {
  accessToken: string;
}

/** Secrets are always resolved by connection, never from process-wide provider tokens. */
export interface SecretProvider {
  getConnectionSecret(input: {
    connectionId: string;
    workspaceId: string;
    provider: Provider;
  }): Promise<ConnectionSecret>;
}

export interface VaultSecretReader {
  read(reference: string): Promise<Record<string, unknown> | null>;
}

export class ConnectionCredentialError extends Error {
  readonly retryable = false;
  constructor(message: string) {
    super(message);
    this.name = 'ConnectionCredentialError';
  }
}

export class DatabaseSecretProvider implements SecretProvider {
  constructor(private readonly transaction: TransactionRunner, private readonly vault?: VaultSecretReader) {}

  async getConnectionSecret(input: { connectionId: string; workspaceId: string; provider: Provider }) {
    const result = await this.transaction(db => db.query(
      `SELECT credentials FROM channel_connections
       WHERE id = $1 AND workspace_id = $2 AND channel = $3 AND is_active IS TRUE`,
      [input.connectionId, input.workspaceId, input.provider]
    ));
    const credentials = result.rows[0]?.credentials as Record<string, unknown> | undefined;
    if (!credentials) throw new ConnectionCredentialError('Active channel connection not found');

    const reference = typeof credentials.vault_ref === 'string' ? credentials.vault_ref : undefined;
    const resolved = reference && this.vault ? await this.vault.read(reference) : credentials;
    const accessToken = resolved && (
      resolved.access_token ?? resolved.bot_token ?? resolved.page_access_token ?? resolved.token
    );
    if (typeof accessToken !== 'string' || !accessToken) {
      throw new ConnectionCredentialError('Connection credential is unavailable');
    }
    return { accessToken };
  }
}
