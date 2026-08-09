"use client";

import { Bell, ChevronDown, Menu, Search } from "lucide-react";
import { cn } from "@/lib/utils";

interface TopbarProps {
  onMenuClick?: () => void;
  className?: string;
}

/**
 * Topbar — workspace switcher (placeholder), search (placeholder, non-functional),
 * notifications (placeholder), account menu (static/placeholder).
 * No real logic wired here — that's AUTH-03/AUTH-04's territory.
 */
export function Topbar({ onMenuClick, className }: TopbarProps) {
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

      {/* Workspace switcher placeholder — real switching lands in AUTH-04 */}
      <button
        type="button"
        className="hidden items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-sm font-medium text-foreground hover:bg-background-muted sm:inline-flex"
      >
        <span className="truncate max-w-[10rem]">My Workspace</span>
        <ChevronDown className="h-3.5 w-3.5 text-foreground-muted" />
      </button>

      {/* Search placeholder — non-functional for this issue */}
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
        {/* Notifications placeholder */}
        <button
          type="button"
          aria-label="Notifications"
          className="relative inline-flex h-8 w-8 items-center justify-center rounded-md text-foreground-muted hover:bg-background-muted hover:text-foreground"
        >
          <Bell className="h-4 w-4" />
        </button>

        {/* Account menu placeholder — no real logout wiring (AUTH-03) */}
        <button
          type="button"
          aria-label="Account menu"
          className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-brand-500 text-xs font-semibold text-white"
        >
          U
        </button>
      </div>
    </header>
  );
}
