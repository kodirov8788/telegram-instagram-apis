import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { withLiveAuthorization } from '@/lib/auth/session';
import { errorResponse, HttpError, parseBody, parseValue, uuid } from '@/lib/http/validation';
import { KnowledgeBaseService } from '@/lib/services/knowledge-base';
import { AuditLogService } from '@/lib/services/audit-log';

const category = z.enum(['faq', 'catalog', 'policy', 'script']);
const language = z.enum(['uz', 'ru', 'en']);

const updateSchema = z.object({
  title: z.string().min(1).max(255).optional(),
  content: z.string().min(1).optional(),
  category: category.optional(),
  language: language.optional(),
  isApproved: z.boolean().optional(),
  validFrom: z.string().date().nullable().optional(),
  validUntil: z.string().date().nullable().optional(),
}).strict();

const target = (ctx: { params: Promise<{ itemId: string }> }) => ctx.params.then(p => parseValue(p.itemId, uuid));

export async function GET(req: NextRequest, ctx: { params: Promise<{ itemId: string }> }) {
  try {
    const itemId = await target(ctx);
    const item = await withLiveAuthorization(req, 'knowledge:read', (p, client) =>
      KnowledgeBaseService.getKnowledgeItem(p.workspaceId, itemId, client)
    );
    if (!item) throw new HttpError(404, 'Knowledge item not found');
    return NextResponse.json({ item });
  } catch (error) { return errorResponse(error); }
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ itemId: string }> }) {
  try {
    const itemId = await target(ctx);
    const body = await parseBody(req, updateSchema);
    if (Object.keys(body).length === 0) throw new HttpError(400, 'No fields to update');

    const item = await withLiveAuthorization(req, 'knowledge:write', async (p, client) => {
      const updated = await KnowledgeBaseService.updateKnowledgeItem(p.workspaceId, itemId, body, client);
      if (!updated) throw new HttpError(404, 'Knowledge item not found');
      await AuditLogService.logEvent({
        workspaceId: p.workspaceId,
        actorType: 'user',
        actorId: p.userId,
        action: 'knowledge.updated',
        entityType: 'knowledge_item',
        entityId: updated.id,
        newValue: body,
      });
      return updated;
    });

    return NextResponse.json({ item });
  } catch (error) { return errorResponse(error); }
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ itemId: string }> }) {
  try {
    const itemId = await target(ctx);

    await withLiveAuthorization(req, 'knowledge:write', async (p, client) => {
      const deleted = await KnowledgeBaseService.deleteKnowledgeItem(p.workspaceId, itemId, client);
      if (!deleted) throw new HttpError(404, 'Knowledge item not found');
      await AuditLogService.logEvent({
        workspaceId: p.workspaceId,
        actorType: 'user',
        actorId: p.userId,
        action: 'knowledge.deleted',
        entityType: 'knowledge_item',
        entityId: deleted.id,
      });
    });

    return NextResponse.json({ ok: true });
  } catch (error) { return errorResponse(error); }
}
