"use client";

import { useState } from "react";
import { Sidebar } from "./Sidebar";
import { Topbar } from "./Topbar";
import { cn } from "@/lib/utils";
import { WorkspaceProvider } from "@/lib/workspace/context";

interface AppShellProps {
  children: React.ReactNode;
  className?: string;
}

/**
 * AppShell — shared product layout: sidebar + topbar + content area.
 *
 * Wraps its children in `WorkspaceProvider` (AUTH-04, #87) so every
 * AppShell-wrapped page can call `useWorkspace()` for the active workspace
 * and its `apiFetch` helper (which attaches `x-workspace-id` automatically)
 * without each page standing up its own provider. Scoped here rather than
 * the root layout so unauthenticated pages (/login, /signup) don't
 * needlessly call `GET /api/workspaces` and hit a 401.
 *
 * Responsive: sidebar is an off-canvas overlay below md, a fixed column above it.
 */
export function AppShell({ children, className }: AppShellProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <WorkspaceProvider>
      <div className="flex h-screen w-full overflow-hidden bg-background">
        {/* Desktop sidebar */}
        <Sidebar
          collapsed={collapsed}
          onToggle={() => setCollapsed((c) => !c)}
          className="hidden md:flex"
        />

        {/* Mobile off-canvas sidebar */}
        {mobileOpen && (
          <div className="fixed inset-0 z-40 flex md:hidden">
            <div
              className="fixed inset-0 bg-black/30"
              onClick={() => setMobileOpen(false)}
              aria-hidden="true"
            />
            <Sidebar
              collapsed={false}
              onToggle={() => setMobileOpen(false)}
              className="relative z-50 flex"
            />
          </div>
        )}

        <div className="flex min-w-0 flex-1 flex-col">
          <Topbar onMenuClick={() => setMobileOpen(true)} />
          <main className={cn("flex-1 overflow-y-auto p-4 sm:p-6", className)}>
            {children}
          </main>
        </div>
      </div>
    </WorkspaceProvider>
  );
}
