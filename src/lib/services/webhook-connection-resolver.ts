import { z } from 'zod';
import { runtimeRoleTransaction } from '@/lib/db';

export type WebhookProvider = 'telegram' | 'instagram';

export interface ResolvedWebhookConnection {
  id: string;
  workspaceId: string;
  channel: WebhookProvider;
  accountIdentifier: string;
  /** Server-only credential material (webhook secrets/tokens). Never return this
   * value through an HTTP response or log it. */
  credentials: Record<string, unknown>;
}

const providerSchema = z.enum(['telegram', 'instagram']);
const identifierSchema = z.string().uuid();

/**
 * Resolves exactly one active channel connection from an opaque, caller-supplied
 * webhook locator. The locator is a routing capability, not authorization or
 * tenant identity: callers must still verify the provider signature/secret
 * against the returned credentials before trusting the event.
 *
 * Unknown identifiers, wrong providers, and inactive connections all resolve to
 * null so callers reject them identically (no existence oracle).
 */
export async function resolveActiveWebhookConnection(
  provider: WebhookProvider,
  webhookIdentifier: string | null | undefined,
): Promise<ResolvedWebhookConnection | null> {
  const parsedProvider = providerSchema.safeParse(provider);
  const parsedIdentifier = identifierSchema.safeParse(webhookIdentifier);
  if (!parsedProvider.success || !parsedIdentifier.success) return null;

  return runtimeRoleTransaction(async client => {
    await client.query("SELECT set_config('app.webhook_identifier', $1, true)", [parsedIdentifier.data]);
    await client.query("SELECT set_config('app.webhook_provider', $1, true)", [parsedProvider.data]);
    const result = await client.query(
      `SELECT id, workspace_id, channel, account_identifier, credentials
       FROM channel_connections
       WHERE webhook_identifier = $1 AND channel = $2 AND is_active = TRUE
       LIMIT 1`,
      [parsedIdentifier.data, parsedProvider.data],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      channel: row.channel,
      accountIdentifier: row.account_identifier,
      credentials: row.credentials ?? {},
    };
  });
}
