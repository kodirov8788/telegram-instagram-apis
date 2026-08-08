import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { withLiveAuthorization } from '@/lib/auth/session';
import { errorResponse, HttpError, parseBody, parseValue, uuid } from '@/lib/http/validation';
import { KnowledgeBaseService } from '@/lib/services/knowledge-base';
import { AuditLogService } from '@/lib/services/audit-log';

const schema = z.object({ isApproved: z.boolean().optional() }).strict();

const target = (ctx: { params: Promise<{ itemId: string }> }) => ctx.params.then(p => parseValue(p.itemId, uuid));

// Dedicated approve/unapprove endpoint, mirroring the messages
// approve/reject route pattern. Body defaults to { isApproved: true };
// pass { "isApproved": false } to revoke approval.
export async function POST(req: NextRequest, ctx: { params: Promise<{ itemId: string }> }) {
  try {
    const itemId = await target(ctx);
    const body = await parseBody(req, schema);
    const isApproved = body.isApproved ?? true;

    const item = await withLiveAuthorization(req, 'knowledge:write', async (p, client) => {
      const updated = await KnowledgeBaseService.setApproval(p.workspaceId, itemId, isApproved, client);
      if (!updated) throw new HttpError(404, 'Knowledge item not found');
      await AuditLogService.logEvent({
        workspaceId: p.workspaceId,
        actorType: 'user',
        actorId: p.userId,
        action: isApproved ? 'knowledge.approved' : 'knowledge.unapproved',
        entityType: 'knowledge_item',
        entityId: updated.id,
        newValue: { isApproved },
      });
      return updated;
    });

    return NextResponse.json({ item });
  } catch (error) { return errorResponse(error); }
}
