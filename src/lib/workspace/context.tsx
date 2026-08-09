'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

export interface WorkspaceSummary {
  id: string;
  name: string;
  role: string;
}

export interface WorkspaceContextValue {
  workspaces: WorkspaceSummary[];
  activeWorkspace: WorkspaceSummary | null;
  loading: boolean;
  error: string | null;
  selectWorkspace: (id: string) => void;
  refresh: () => Promise<void>;
  apiFetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
}

const STORAGE_KEY = 'ydeck.activeWorkspaceId';

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

function readStoredWorkspaceId(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeStoredWorkspaceId(id: string | null) {
  if (typeof window === 'undefined') return;
  try {
    if (id) window.localStorage.setItem(STORAGE_KEY, id);
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage unavailable (private mode, disabled, etc.) — fall back to in-memory only.
  }
}

/**
 * WorkspaceProvider — the single shared client mechanism for workspace
 * discovery and workspace-scoped requests (AUTH-04, #87).
 *
 * On mount, calls `GET /api/workspaces` to discover which workspace(s) the
 * authenticated user belongs to, then:
 *  - zero workspaces  -> `activeWorkspace` stays null (caller should route
 *    to onboarding — UI-03/#92 builds that screen).
 *  - exactly one      -> auto-selected as the active workspace (MVP rule
 *    from the issue).
 *  - multiple         -> restores a previously-selected id from
 *    localStorage if it's still a valid membership, otherwise leaves the
 *    choice to the caller via `selectWorkspace`.
 *
 * Every other route in this codebase requires `x-workspace-id`
 * (`selectedWorkspace()` in `src/lib/auth/session.ts`), so `apiFetch` is
 * provided as the one shared helper that attaches it automatically —
 * consuming pages/PRs should use this instead of raw `fetch` for any
 * workspace-scoped API call.
 */
export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/workspaces', { credentials: 'include' });
      if (!res.ok) throw new Error(`Failed to load workspaces (${res.status})`);
      const data = (await res.json()) as { workspaces: WorkspaceSummary[] };
      const list = data.workspaces ?? [];
      setWorkspaces(list);

      setActiveWorkspaceId(current => {
        if (list.length === 1) {
          writeStoredWorkspaceId(list[0].id);
          return list[0].id;
        }
        const stored = current ?? readStoredWorkspaceId();
        if (stored && list.some(w => w.id === stored)) return stored;
        return null;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load workspaces');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectWorkspace = useCallback((id: string) => {
    setActiveWorkspaceId(id);
    writeStoredWorkspaceId(id);
  }, []);

  const apiFetch = useCallback(
    (input: RequestInfo | URL, init: RequestInit = {}) => {
      const headers = new Headers(init.headers);
      if (activeWorkspaceId) headers.set('x-workspace-id', activeWorkspaceId);
      return fetch(input, { ...init, headers, credentials: init.credentials ?? 'include' });
    },
    [activeWorkspaceId],
  );

  const activeWorkspace = useMemo(
    () => workspaces.find(w => w.id === activeWorkspaceId) ?? null,
    [workspaces, activeWorkspaceId],
  );

  const value = useMemo<WorkspaceContextValue>(
    () => ({ workspaces, activeWorkspace, loading, error, selectWorkspace, refresh, apiFetch }),
    [workspaces, activeWorkspace, loading, error, selectWorkspace, refresh, apiFetch],
  );

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace(): WorkspaceContextValue {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) throw new Error('useWorkspace must be used within a WorkspaceProvider');
  return ctx;
}
