import { NextRequest, NextResponse } from 'next/server';
import { authenticate } from '@/lib/auth/session';
import { errorResponse } from '@/lib/http/validation';
export async function GET(req: NextRequest) {
  try { return NextResponse.json({ user: await authenticate(req) }); }
  catch (error) { return errorResponse(error); }
}
