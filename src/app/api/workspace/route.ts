import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { WorkspaceService } from '@/lib/services/workspace';
import { authenticate, withLiveAuthorization } from '@/lib/auth/session';
import { errorResponse, parseBody } from '@/lib/http/validation';

const hours = z.object({ start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/), end: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/), days: z.array(z.number().int().min(0).max(6)).min(1) }).strict();
const createSchema = z.object({ name: z.string().trim().min(1).max(255), industry: z.string().trim().max(100).optional(), timeZone: z.string().trim().max(100).optional(), defaultLanguage: z.enum(['uz', 'ru', 'en']).optional(), workingHours: hours.optional() }).strict();
const updateSchema = createSchema.partial().refine(v => Object.keys(v).length > 0);

export async function GET(req: NextRequest) {
  try { return NextResponse.json({ workspace: await withLiveAuthorization(req, 'workspace:read', (p, client) => WorkspaceService.getWorkspaceById(p.workspaceId, client)) }); }
  catch (error) { return errorResponse(error); }
}
export async function POST(req: NextRequest) {
  try { const p = await authenticate(req); const body = await parseBody(req, createSchema); return NextResponse.json({ workspace: await WorkspaceService.createWorkspace(body, p.userId) }, { status: 201 }); }
  catch (error) { return errorResponse(error); }
}
export async function PUT(req: NextRequest) {
  try { return NextResponse.json({ workspace: await withLiveAuthorization(req, 'workspace:update', async (p, client) => WorkspaceService.updateWorkspaceConfig(p.workspaceId, await parseBody(req, updateSchema), client)) }); }
  catch (error) { return errorResponse(error); }
}
