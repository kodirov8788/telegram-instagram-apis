"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Inbox,
  Users,
  BookOpen,
  BarChart3,
  Plug,
  Settings,
  Menu,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";

export interface NavItem {
  label: string;
  href: string;
  icon: React.ComponentType<{ className?: string }>;
}

export const NAV_ITEMS: NavItem[] = [
  { label: "Inbox", href: "/inbox", icon: Inbox },
  { label: "Leads", href: "/leads", icon: Users },
  { label: "Knowledge", href: "/knowledge", icon: BookOpen },
  { label: "Analytics", href: "/analytics", icon: BarChart3 },
  { label: "Connections", href: "/connections", icon: Plug },
  { label: "Settings", href: "/settings", icon: Settings },
];

function isActive(pathname: string, href: string) {
  return pathname === href || pathname.startsWith(`${href}/`);
}

interface SidebarProps {
  collapsed: boolean;
  onToggle: () => void;
  className?: string;
}

/**
 * Sidebar — primary product navigation.
 * Desktop: fixed-width column, collapsible to icon-only.
 * Mobile (<768px): hidden by default, slides in as an overlay when toggled.
 */
export function Sidebar({ collapsed, onToggle, className }: SidebarProps) {
  const pathname = usePathname();

  return (
    <aside
      className={cn(
        "flex h-full flex-col border-r border-border bg-background-subtle transition-all duration-200",
        collapsed ? "w-16" : "w-60",
        className
      )}
    >
      <div className="flex h-14 items-center justify-between border-b border-border px-3">
        {!collapsed && (
          <span className="truncate text-sm font-semibold text-foreground">
            YDeck
          </span>
        )}
        <button
          type="button"
          onClick={onToggle}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          className="ml-auto inline-flex h-8 w-8 items-center justify-center rounded-md text-foreground-muted hover:bg-background-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
        >
          {collapsed ? <Menu className="h-4 w-4" /> : <X className="h-4 w-4" />}
        </button>
      </div>

      <nav className="flex-1 space-y-1 overflow-y-auto px-2 py-3">
        {NAV_ITEMS.map((item) => {
          const active = isActive(pathname ?? "", item.href);
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              title={collapsed ? item.label : undefined}
              className={cn(
                "flex items-center gap-3 rounded-md px-2.5 py-2 text-sm font-medium transition-colors",
                active
                  ? "bg-brand-100 text-brand-700"
                  : "text-foreground-muted hover:bg-background-muted hover:text-foreground",
                collapsed && "justify-center"
              )}
              aria-current={active ? "page" : undefined}
            >
              <Icon className="h-4 w-4 shrink-0" />
              {!collapsed && <span className="truncate">{item.label}</span>}
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
