import type { Session, User } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase/client';
import { clearStoredActiveWorkspace } from '@/lib/workspace/storage';

/**
 * Client-safe email/password auth wrappers around Supabase Auth
 * (`supabase.auth.signUp` / `signInWithPassword` / `signOut`).
 *
 * These call the browser client directly — Supabase's own client library is
 * the standard way to hit Auth's API from the client, no server route needed
 * (per AUTH-03 scope). They're plain functions rather than a class so UI-03
 * can call them straight from client components / form actions.
 *
 * Every failure is normalized into `AuthError` with a stable `code` so
 * callers (UI-03) can branch on the failure kind instead of parsing
 * free-text Supabase messages.
 */

export type AuthErrorCode =
  | 'invalid_credentials'
  | 'email_already_registered'
  | 'weak_password'
  | 'email_not_confirmed'
  | 'invalid_email'
  | 'rate_limited'
  | 'unknown';

export class AuthError extends Error {
  code: AuthErrorCode;

  constructor(code: AuthErrorCode, message: string) {
    super(message);
    this.name = 'AuthError';
    this.code = code;
  }
}

export interface AuthResult {
  user: User | null;
  session: Session | null;
}

/**
 * Map a raw Supabase Auth error to a stable `AuthErrorCode`.
 *
 * Supabase does not expose a single stable machine-readable error code
 * across SDK versions for every case, so this matches on `error.code`
 * (when present, newer supabase-js) with a message-substring fallback
 * (older/edge cases) — kept deliberately narrow and documented per case.
 */
function toAuthError(error: { code?: string; message: string; status?: number }): AuthError {
  const message = error.message.toLowerCase();

  if (error.code === 'invalid_credentials' || message.includes('invalid login credentials')) {
    return new AuthError('invalid_credentials', 'Incorrect email or password.');
  }
  if (error.code === 'user_already_exists' || message.includes('already registered') || message.includes('already exists')) {
    return new AuthError('email_already_registered', 'An account with this email already exists.');
  }
  if (error.code === 'weak_password' || message.includes('password') && message.includes('at least')) {
    return new AuthError('weak_password', 'Password is too weak. Use at least 8 characters.');
  }
  if (error.code === 'email_not_confirmed' || message.includes('email not confirmed')) {
    return new AuthError('email_not_confirmed', 'Please confirm your email address before logging in.');
  }
  if (error.code === 'validation_failed' || message.includes('unable to validate email') || message.includes('invalid email')) {
    return new AuthError('invalid_email', 'Please enter a valid email address.');
  }
  if (error.code === 'over_request_rate_limit' || error.status === 429 || message.includes('rate limit')) {
    return new AuthError('rate_limited', 'Too many attempts. Please try again shortly.');
  }
  return new AuthError('unknown', error.message || 'Something went wrong. Please try again.');
}

/** Sign up with email/password via Supabase Auth. */
export async function signUpWithPassword(email: string, password: string): Promise<AuthResult> {
  const supabase = createClient();
  const { data, error } = await supabase.auth.signUp({ email, password });
  if (error) throw toAuthError(error);
  return { user: data.user, session: data.session };
}

/** Log in with email/password via Supabase Auth. */
export async function signInWithPassword(email: string, password: string): Promise<AuthResult> {
  const supabase = createClient();
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw toAuthError(error);
  return { user: data.user, session: data.session };
}

/** Log out the current Supabase Auth session. */
export async function signOut(): Promise<void> {
  const supabase = createClient();
  const { error } = await supabase.auth.signOut();
  // Clear the stored active-workspace id regardless of outcome — a failed
  // signOut still means this browser should not silently carry the
  // previous session's workspace selection forward.
  clearStoredActiveWorkspace();
  if (error) throw toAuthError(error);
}
