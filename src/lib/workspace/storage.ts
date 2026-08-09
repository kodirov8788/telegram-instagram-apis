/**
 * Plain (non-JSX) localStorage helpers for the active-workspace selection.
 * Split out from `context.tsx` so JSX-free client code (e.g.
 * `src/lib/auth/supabase-auth.ts`'s `signOut()`) can clear the stored
 * selection on logout without pulling React/JSX into its import chain —
 * that import previously broke `supabase-auth.test.ts` under Vitest's
 * default (no-JSX-in-.ts-context) transform config.
 */

const STORAGE_KEY = 'ydeck.activeWorkspaceId';

export function readStoredWorkspaceId(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export function writeStoredWorkspaceId(id: string | null) {
  if (typeof window === 'undefined') return;
  try {
    if (id) window.localStorage.setItem(STORAGE_KEY, id);
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage unavailable (private mode, disabled, etc.) — fall back to in-memory only.
  }
}

/**
 * Per independent review of #109: the stored active-workspace id was never
 * cleared on logout, so a shared browser could carry a stale id into a
 * different user's next session. `WorkspaceProvider.refresh()` already
 * re-validates the stored id against the freshly fetched membership list
 * before accepting it (so this was never a cross-tenant data leak), but a
 * real logout should still start the next session clean. Called from
 * `signOut()` (`src/lib/auth/supabase-auth.ts`).
 */
export function clearStoredActiveWorkspace() {
  writeStoredWorkspaceId(null);
}
