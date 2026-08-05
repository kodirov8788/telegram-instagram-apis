import type { DbClient } from '../db';

export type CustomerProvider = 'telegram' | 'instagram';

export interface ConnectionCustomerIdentity {
  connectionId: string;
  provider: CustomerProvider;
  providerUserId: string;
  fullName?: string;
  username?: string;
}

export interface ConnectionCustomer {
  id: string;
  workspace_id: string;
  connection_id: string;
  provider_user_id: string;
}

export class CustomerIdentityService {
  static async upsert(identity: ConnectionCustomerIdentity, client: DbClient): Promise<ConnectionCustomer> {
    if (!identity.connectionId || !identity.providerUserId.trim()) {
      throw new Error('connectionId and providerUserId are required');
    }
    const result = await client.query(
      'SELECT * FROM upsert_connection_customer($1, $2, $3, $4, $5)',
      [
        identity.connectionId,
        identity.provider,
        identity.providerUserId.trim(),
        identity.fullName ?? null,
        identity.username ?? null,
      ],
    );
    const customer = result.rows[0] as ConnectionCustomer | undefined;
    if (!customer) throw new Error('customer identity upsert returned no customer');
    return customer;
  }
}
