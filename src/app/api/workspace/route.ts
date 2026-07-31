import { NextRequest, NextResponse } from 'next/server';
import { WorkspaceService } from '@/lib/services/workspace';

export async function GET(req: NextRequest) {
  try {
    const workspaceId = req.nextUrl.searchParams.get('id') || 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';
    const workspace = await WorkspaceService.getWorkspaceById(workspaceId);
    return NextResponse.json({ workspace });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { name, industry, timeZone, defaultLanguage, workingHours, ownerUserId } = body;

    const workspace = await WorkspaceService.createWorkspace(
      { name, industry, timeZone, defaultLanguage, workingHours },
      ownerUserId || '00000000-0000-0000-0000-000000000000'
    );

    return NextResponse.json({ workspace });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  try {
    const body = await req.json();
    const { id, name, industry, defaultLanguage, workingHours } = body;

    const updated = await WorkspaceService.updateWorkspaceConfig(id, {
      name,
      industry,
      defaultLanguage,
      workingHours,
    });

    return NextResponse.json({ workspace: updated });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
