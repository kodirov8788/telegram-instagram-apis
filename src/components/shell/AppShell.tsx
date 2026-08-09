"use client";

import { useState } from "react";
import { Sidebar } from "./Sidebar";
import { Topbar } from "./Topbar";
import { cn } from "@/lib/utils";

interface AppShellProps {
  children: React.ReactNode;
  className?: string;
}

/**
 * AppShell — shared product layout: sidebar + topbar + content area.
 * Wraps product pages once they're rewired in UI-04/UI-07. Not wired into
 * /inbox or /analytics yet (those own their own layout until then).
 *
 * Responsive: sidebar is an off-canvas overlay below md, a fixed column above it.
 */
export function AppShell({ children, className }: AppShellProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
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
  );
}
