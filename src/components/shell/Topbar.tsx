"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Bell, ChevronDown, LogOut, Menu, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { useWorkspace } from "@/lib/workspace/context";
import { signOut } from "@/lib/auth/supabase-auth";

interface TopbarProps {
  onMenuClick?: () => void;
  className?: string;
}

/**
 * Topbar — workspace switcher (real, via useWorkspace()), search
 * (placeholder, non-functional — out of scope), notifications (placeholder),
 * account menu with real logout.
 *
 * Topbar is rendered inside AppShell, which mounts WorkspaceProvider, so
 * useWorkspace() resolves correctly here.
 */
export function Topbar({ onMenuClick, className }: TopbarProps) {
  const router = useRouter();
  const { workspaces, activeWorkspace, selectWorkspace } = useWorkspace();
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  async function handleLogout() {
    if (signingOut) return;
    setSigningOut(true);
    try {
      await signOut();
    } finally {
      // Always redirect to /login, even if signOut() itself errored — a
      // failed sign-out call is not a reason to strand the user on an
      // authenticated page; the middleware will bounce them back if the
      // session is somehow still valid.
      router.push("/login");
    }
  }

  return (
    <header
      className={cn(
        "flex h-14 items-center gap-3 border-b border-border bg-background px-4",
        className
      )}
    >
      {onMenuClick && (
        <button
          type="button"
          onClick={onMenuClick}
          aria-label="Toggle navigation"
          className="inline-flex h-8 w-8 items-center justify-center rounded-md text-foreground-muted hover:bg-background-muted hover:text-foreground md:hidden"
        >
          <Menu className="h-4 w-4" />
        </button>
      )}

      {workspaces.length > 1 ? (
        <div className="relative hidden sm:inline-flex items-center">
          <select
            aria-label="Switch workspace"
            value={activeWorkspace?.id ?? ""}
            onChange={(e) => selectWorkspace(e.target.value)}
            className="h-8 appearance-none rounded-md border border-border bg-background pl-2.5 pr-7 text-sm font-medium text-foreground hover:bg-background-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
          >
            {workspaces.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
          <ChevronDown className="pointer-events-none absolute right-2 h-3.5 w-3.5 text-foreground-muted" />
        </div>
      ) : (
        <span className="hidden sm:inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-sm font-medium text-foreground">
          <span className="truncate max-w-[10rem]">{activeWorkspace?.name ?? "—"}</span>
        </span>
      )}

      {/* Search placeholder — non-functional, out of scope */}
      <div className="relative ml-1 flex-1 max-w-md">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-foreground-subtle" />
        <input
          type="search"
          placeholder="Search..."
          disabled
          aria-label="Search"
          className="w-full rounded-md border border-border bg-background-subtle py-1.5 pl-8 pr-3 text-sm text-foreground placeholder:text-foreground-subtle disabled:cursor-not-allowed"
        />
      </div>

      <div className="ml-auto flex items-center gap-2">
        {/* Notifications placeholder — out of scope */}
        <button
          type="button"
          aria-label="Notifications"
          className="relative inline-flex h-8 w-8 items-center justify-center rounded-md text-foreground-muted hover:bg-background-muted hover:text-foreground"
        >
          <Bell className="h-4 w-4" />
        </button>

        <div className="relative">
          <button
            type="button"
            aria-label="Account menu"
            aria-expanded={accountMenuOpen}
            onClick={() => setAccountMenuOpen((v) => !v)}
            className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-brand-500 text-xs font-semibold text-white"
          >
            U
          </button>
          {accountMenuOpen && (
            <>
              {/* Backdrop to close on outside click */}
              <div
                className="fixed inset-0 z-40"
                onClick={() => setAccountMenuOpen(false)}
                aria-hidden="true"
              />
              <div className="absolute right-0 z-50 mt-2 w-40 rounded-md border border-border bg-background py-1 shadow-card">
                <button
                  type="button"
                  onClick={handleLogout}
                  disabled={signingOut}
                  className="flex w-full items-center gap-2 px-3 py-2 text-sm text-foreground hover:bg-background-muted disabled:opacity-60"
                >
                  <LogOut className="h-4 w-4" />
                  {signingOut ? "Signing out…" : "Log out"}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </header>
  );
}
