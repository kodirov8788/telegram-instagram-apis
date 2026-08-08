import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { withLiveAuthorization } from '@/lib/auth/session';
import { errorResponse, parseBody, parseValue } from '@/lib/http/validation';
import { KnowledgeBaseService } from '@/lib/services/knowledge-base';
import { AuditLogService } from '@/lib/services/audit-log';

const category = z.enum(['faq', 'catalog', 'policy', 'script']);
const language = z.enum(['uz', 'ru', 'en']);
const boolFromQuery = z.enum(['true', 'false']);

const createSchema = z.object({
  title: z.string().min(1).max(255),
  content: z.string().min(1),
  category: category.optional(),
  language: language.optional(),
  isApproved: z.boolean().optional(),
  validFrom: z.string().date().nullable().optional(),
  validUntil: z.string().date().nullable().optional(),
}).strict();

export async function GET(req: NextRequest) {
  try {
    const params = req.nextUrl.searchParams;
    const categoryFilter = params.get('category') ? parseValue(params.get('category'), category) : undefined;
    const languageFilter = params.get('language') ? parseValue(params.get('language'), language) : undefined;
    const approvedFilter = params.get('isApproved') ? parseValue(params.get('isApproved'), boolFromQuery) === 'true' : undefined;

    const rows = await withLiveAuthorization(req, 'knowledge:read', (p, client) =>
      KnowledgeBaseService.listKnowledgeItems(
        p.workspaceId,
        { category: categoryFilter, language: languageFilter, isApproved: approvedFilter },
        client
      )
    );

    return NextResponse.json({ items: rows });
  } catch (error) { return errorResponse(error); }
}

export async function POST(req: NextRequest) {
  try {
    const body = await parseBody(req, createSchema);

    const item = await withLiveAuthorization(req, 'knowledge:write', async (p, client) => {
      const created = await KnowledgeBaseService.addKnowledgeItem(
        { workspaceId: p.workspaceId, ...body },
        client
      );
      await AuditLogService.logEvent({
        workspaceId: p.workspaceId,
        actorType: 'user',
        actorId: p.userId,
        action: 'knowledge.created',
        entityType: 'knowledge_item',
        entityId: created.id,
        newValue: { title: created.title, category: created.category, language: created.language },
      });
      return created;
    });

    return NextResponse.json({ item }, { status: 201 });
  } catch (error) { return errorResponse(error); }
}
