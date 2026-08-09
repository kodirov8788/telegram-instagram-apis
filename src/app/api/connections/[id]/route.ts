import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { withLiveAuthorization } from '@/lib/auth/session';
import { errorResponse, HttpError, parseBody, parseValue, uuid } from '@/lib/http/validation';
import { ConnectionsService } from '@/lib/services/connections';
import { rotateConnectionSecret } from '@/lib/services/connection-secret-loader';
import { AuditLogService } from '@/lib/services/audit-log';

// `credential` is the only way to set/rotate the stored secret. It is
// accepted here (never returned, never logged) and routed straight to
// rotateConnectionSecret, which stores it in Supabase Vault and repoints
// credentials_vault_id — it is never written to the `credentials` column.
const updateSchema = z.object({
  accountIdentifier: z.string().min(1).max(255).optional(),
  isActive: z.boolean().optional(),
  credential: z.record(z.string(), z.unknown()).optional(),
}).strict();

const target = (ctx: { params: Promise<{ id: string }> }) => ctx.params.then(p => parseValue(p.id, uuid));

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const id = await target(ctx);
    const connection = await withLiveAuthorization(req, 'connections:read', (p, client) =>
      ConnectionsService.getConnection(p.workspaceId, id, client)
    );
    if (!connection) throw new HttpError(404, 'Connection not found');
    return NextResponse.json({ connection });
  } catch (error) { return errorResponse(error); }
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const id = await target(ctx);
    const body = await parseBody(req, updateSchema);
    if (Object.keys(body).length === 0) throw new HttpError(400, 'No fields to update');

    const connection = await withLiveAuthorization(req, 'connections:write', async (p, client) => {
      const existing = await ConnectionsService.getConnection(p.workspaceId, id, client);
      if (!existing) throw new HttpError(404, 'Connection not found');

      const updated = await ConnectionsService.updateConnection(
        p.workspaceId,
        id,
        { accountIdentifier: body.accountIdentifier, isActive: body.isActive },
        client
      );
      if (!updated) throw new HttpError(404, 'Connection not found');

      if (body.credential) {
        await rotateConnectionSecret(id, p.workspaceId, body.credential);
      }

      await AuditLogService.logEvent({
        workspaceId: p.workspaceId,
        actorType: 'user',
        actorId: p.userId,
        action: 'connection.updated',
        entityType: 'channel_connection',
        entityId: id,
        // Never include `credential` in the audit trail — only note that a
        // rotation happened, never its contents.
        newValue: {
          accountIdentifier: body.accountIdentifier,
          isActive: body.isActive,
          credentialRotated: body.credential !== undefined,
        },
      });

      return updated;
    });

    return NextResponse.json({ connection });
  } catch (error) { return errorResponse(error); }
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const id = await target(ctx);

    await withLiveAuthorization(req, 'connections:write', async (p, client) => {
      const deleted = await ConnectionsService.deleteConnection(p.workspaceId, id, client);
      if (!deleted) throw new HttpError(404, 'Connection not found');
      await AuditLogService.logEvent({
        workspaceId: p.workspaceId,
        actorType: 'user',
        actorId: p.userId,
        action: 'connection.deleted',
        entityType: 'channel_connection',
        entityId: id,
      });
    });

    return NextResponse.json({ ok: true });
  } catch (error) { return errorResponse(error); }
}
