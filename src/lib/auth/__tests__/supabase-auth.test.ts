import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const supabaseMocks = vi.hoisted(() => ({
  signUp: vi.fn(),
  signInWithPassword: vi.fn(),
  signOut: vi.fn(),
  getUser: vi.fn(),
}));

vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    auth: {
      signUp: supabaseMocks.signUp,
      signInWithPassword: supabaseMocks.signInWithPassword,
      signOut: supabaseMocks.signOut,
    },
  }),
}));

vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: () => ({ auth: { getUser: supabaseMocks.getUser } }),
}));

vi.mock('@/lib/db', () => ({ query: vi.fn() }));

import { AuthError, signInWithPassword, signOut, signUpWithPassword } from '../supabase-auth';
import { authenticate } from '../session';

beforeEach(() => {
  supabaseMocks.signUp.mockReset();
  supabaseMocks.signInWithPassword.mockReset();
  supabaseMocks.signOut.mockReset();
  supabaseMocks.getUser.mockReset();
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://test.supabase.co';
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'test-anon-key';
});

describe('signUpWithPassword', () => {
  it('signs up successfully and returns user + session', async () => {
    const user = { id: 'u1', email: 'new@test.dev' };
    const session = { access_token: 'tok' };
    supabaseMocks.signUp.mockResolvedValueOnce({ data: { user, session }, error: null });

    await expect(signUpWithPassword('new@test.dev', 'password123')).resolves.toEqual({ user, session });
    expect(supabaseMocks.signUp).toHaveBeenCalledWith({ email: 'new@test.dev', password: 'password123' });
  });

  it('throws a distinguishable error for a duplicate email', async () => {
    supabaseMocks.signUp.mockResolvedValueOnce({
      data: { user: null, session: null },
      error: { code: 'user_already_exists', message: 'User already registered', status: 422 },
    });

    const err = await signUpWithPassword('dupe@test.dev', 'password123').catch(e => e);
    expect(err).toBeInstanceOf(AuthError);
    expect(err.code).toBe('email_already_registered');
  });

  it('throws a distinguishable error for a weak password', async () => {
    supabaseMocks.signUp.mockResolvedValueOnce({
      data: { user: null, session: null },
      error: { code: 'weak_password', message: 'Password should be at least 8 characters', status: 422 },
    });

    const err = await signUpWithPassword('weak@test.dev', '123').catch(e => e);
    expect(err).toBeInstanceOf(AuthError);
    expect(err.code).toBe('weak_password');
  });
});

describe('signInWithPassword', () => {
  it('logs in successfully and returns user + session', async () => {
    const user = { id: 'u1', email: 'user@test.dev' };
    const session = { access_token: 'tok' };
    supabaseMocks.signInWithPassword.mockResolvedValueOnce({ data: { user, session }, error: null });

    await expect(signInWithPassword('user@test.dev', 'password123')).resolves.toEqual({ user, session });
  });

  it('throws a distinguishable error for wrong credentials', async () => {
    supabaseMocks.signInWithPassword.mockResolvedValueOnce({
      data: { user: null, session: null },
      error: { code: 'invalid_credentials', message: 'Invalid login credentials', status: 400 },
    });

    const err = await signInWithPassword('user@test.dev', 'wrong').catch(e => e);
    expect(err).toBeInstanceOf(AuthError);
    expect(err.code).toBe('invalid_credentials');
  });

  it('throws a distinguishable error for an unconfirmed email', async () => {
    supabaseMocks.signInWithPassword.mockResolvedValueOnce({
      data: { user: null, session: null },
      error: { code: 'email_not_confirmed', message: 'Email not confirmed', status: 400 },
    });

    const err = await signInWithPassword('unconfirmed@test.dev', 'password123').catch(e => e);
    expect(err).toBeInstanceOf(AuthError);
    expect(err.code).toBe('email_not_confirmed');
  });

  it('falls back to unknown for an unrecognized error', async () => {
    supabaseMocks.signInWithPassword.mockResolvedValueOnce({
      data: { user: null, session: null },
      error: { message: 'Something exploded', status: 500 },
    });

    const err = await signInWithPassword('user@test.dev', 'password123').catch(e => e);
    expect(err).toBeInstanceOf(AuthError);
    expect(err.code).toBe('unknown');
  });
});

describe('signOut', () => {
  it('signs out successfully', async () => {
    supabaseMocks.signOut.mockResolvedValueOnce({ error: null });
    await expect(signOut()).resolves.toBeUndefined();
    expect(supabaseMocks.signOut).toHaveBeenCalled();
  });

  it('throws on sign-out failure', async () => {
    supabaseMocks.signOut.mockResolvedValueOnce({ error: { message: 'network error', status: 500 } });
    const err = await signOut().catch(e => e);
    expect(err).toBeInstanceOf(AuthError);
  });
});

describe('session persistence after signup/login', () => {
  it('authenticate() resolves the principal from a session established via signInWithPassword', async () => {
    const user = { id: 'sb-user-1', email: 'persisted@test.dev' };
    supabaseMocks.signInWithPassword.mockResolvedValueOnce({
      data: { user, session: { access_token: 'tok' } },
      error: null,
    });
    await signInWithPassword('persisted@test.dev', 'password123');

    // A subsequent server-side request resolves the same principal via
    // authenticate() (AUTH-02), simulating the cookie now carrying the
    // Supabase session established by the sign-in above.
    supabaseMocks.getUser.mockResolvedValueOnce({ data: { user }, error: null });
    await expect(authenticate(new NextRequest('https://app.test/api'))).resolves.toEqual({
      userId: 'sb-user-1',
      email: 'persisted@test.dev',
    });
  });

  it('authenticate() resolves the principal from a session established via signUpWithPassword', async () => {
    const user = { id: 'sb-user-2', email: 'newuser@test.dev' };
    supabaseMocks.signUp.mockResolvedValueOnce({
      data: { user, session: { access_token: 'tok2' } },
      error: null,
    });
    await signUpWithPassword('newuser@test.dev', 'password123');

    supabaseMocks.getUser.mockResolvedValueOnce({ data: { user }, error: null });
    await expect(authenticate(new NextRequest('https://app.test/api'))).resolves.toEqual({
      userId: 'sb-user-2',
      email: 'newuser@test.dev',
    });
  });
});
