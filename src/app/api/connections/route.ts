import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { withLiveAuthorization } from '@/lib/auth/session';
import { errorResponse, parseBody } from '@/lib/http/validation';
import { ConnectionsService } from '@/lib/services/connections';
import { AuditLogService } from '@/lib/services/audit-log';

const channel = z.enum(['telegram', 'instagram']);

// Deliberately does NOT accept a raw token/credential here. Storing a
// credential goes through PATCH /api/connections/:id (which calls
// set_connection_secret/rotateConnectionSecret) so plaintext never has a
// chance to land in an application log or a request body other than the
// dedicated credential-rotation path.
const createSchema = z.object({
  channel,
  accountIdentifier: z.string().min(1).max(255),
}).strict();

export async function GET(req: NextRequest) {
  try {
    const rows = await withLiveAuthorization(req, 'connections:read', (p, client) =>
      ConnectionsService.listConnections(p.workspaceId, client)
    );
    return NextResponse.json({ connections: rows });
  } catch (error) { return errorResponse(error); }
}

export async function POST(req: NextRequest) {
  try {
    const body = await parseBody(req, createSchema);

    const connection = await withLiveAuthorization(req, 'connections:write', async (p, client) => {
      const created = await ConnectionsService.createConnection(
        { workspaceId: p.workspaceId, channel: body.channel, accountIdentifier: body.accountIdentifier },
        client
      );
      await AuditLogService.logEvent({
        workspaceId: p.workspaceId,
        actorType: 'user',
        actorId: p.userId,
        action: 'connection.created',
        entityType: 'channel_connection',
        entityId: created.id,
        newValue: { channel: created.channel, account_identifier: created.account_identifier },
      });
      return created;
    });

    return NextResponse.json({ connection }, { status: 201 });
  } catch (error) { return errorResponse(error); }
}
