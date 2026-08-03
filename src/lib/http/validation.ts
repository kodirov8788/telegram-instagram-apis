import { z, type ZodType } from 'zod';

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export const uuid = z.string().uuid();

export async function parseBody<T>(request: Request, schema: ZodType<T>): Promise<T> {
  try {
    return schema.parse(await request.json());
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, 'Invalid request body');
  }
}

export function parseValue<T>(value: unknown, schema: ZodType<T>): T {
  try { return schema.parse(value); }
  catch { throw new HttpError(400, 'Invalid request parameters'); }
}

export function errorResponse(error: unknown): Response {
  const status = error instanceof HttpError ? error.status : 500;
  return Response.json({ error: status === 500 ? 'Internal server error' : error instanceof Error ? error.message : 'Request failed' }, { status });
}
