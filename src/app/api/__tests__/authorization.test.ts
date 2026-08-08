import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/db', () => ({ query: vi.fn(), default: { connect: vi.fn() } }));
vi.mock('@/lib/services/workspace', () => ({ WorkspaceService: { getWorkspaceById: vi.fn(), createWorkspace: vi.fn(), updateWorkspaceConfig: vi.fn() } }));
import { query } from '@/lib/db';
import { GET as workspaceGet, POST as workspacePost, PUT as workspacePut } from '../workspace/route';
import { GET as conversationsGet, PATCH as conversationsPatch } from '../conversations/route';
import { GET as exportGet } from '../leads/export/route';
import { GET as leadsGet } from '../leads/route';
import { POST as invitePost } from '../workspace/invitations/route';
import { GET as membersGet } from '../workspace/members/route';
import { PATCH as memberPatch, DELETE as memberDelete } from '../workspace/members/[userId]/route';

const db = vi.mocked(query);
const req = (url: string, method = 'GET', body?: object) => new NextRequest(url, { method, ...(body ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}) });

beforeEach(() => db.mockReset().mockResolvedValue({ rows: [], rowCount: 0 } as never));

describe('all browser business routes require authentication', () => {
  it.each([
    ['workspace GET', () => workspaceGet(req('https://app.test/api/workspace?id=11111111-1111-4111-8111-111111111111'))],
    ['workspace POST', () => workspacePost(req('https://app.test/api/workspace', 'POST', { name: 'Acme' }))],
    ['workspace PUT', () => workspacePut(req('https://app.test/api/workspace', 'PUT', { id: '11111111-1111-4111-8111-111111111111', name: 'Acme' }))],
    ['conversations GET', () => conversationsGet(req('https://app.test/api/conversations?workspace_id=11111111-1111-4111-8111-111111111111'))],
    ['conversations PATCH', () => conversationsPatch(req('https://app.test/api/conversations', 'PATCH', { conversationId: '11111111-1111-4111-8111-111111111111', status: 'closed' }))],
    ['lead export GET', () => exportGet(req('https://app.test/api/leads/export?workspace_id=11111111-1111-4111-8111-111111111111'))],
    ['leads list GET', () => leadsGet(req('https://app.test/api/leads?workspace_id=11111111-1111-4111-8111-111111111111'))],
    ['invitation POST', () => invitePost(req('https://app.test/api/workspace/invitations', 'POST', { email: 'member@test.dev', role: 'support_operator' }))],
    ['members GET', () => membersGet(req('https://app.test/api/workspace/members?workspace_id=11111111-1111-4111-8111-111111111111'))],
    ['member PATCH', () => memberPatch(req('https://app.test/api/workspace/members/x', 'PATCH', { role: 'support_operator' }), { params: Promise.resolve({ userId: '22222222-2222-4222-8222-222222222222' }) })],
    ['member DELETE', () => memberDelete(req('https://app.test/api/workspace/members/x', 'DELETE'), { params: Promise.resolve({ userId: '22222222-2222-4222-8222-222222222222' }) })],
  ])('%s returns 401', async (_name, call) => expect((await call()).status).toBe(401));
});
