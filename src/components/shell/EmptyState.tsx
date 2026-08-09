import { Inbox as InboxIcon, LucideIcon } from "lucide-react";
import { Button } from "@/components/ui";
import { cn } from "@/lib/utils";

export interface EmptyStateAction {
  label: string;
  onClick: () => void;
}

export interface EmptyStateProps {
  icon?: LucideIcon;
  title: string;
  message?: string;
  action?: EmptyStateAction;
  className?: string;
}

/**
 * EmptyState — generic "nothing here yet" panel with icon, message, and
 * optional action button. Built on UI-01 primitives.
 * Usage: <EmptyState icon={Inbox} title="No conversations" action={{ label: "New chat", onClick: ... }} />
 */
export function EmptyState({
  icon: Icon = InboxIcon,
  title,
  message,
  action,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center gap-3 rounded-lg border border-dashed border-border px-6 py-10 text-center",
        className
      )}
    >
      <div className="flex h-11 w-11 items-center justify-center rounded-full bg-background-muted">
        <Icon className="h-5 w-5 text-foreground-muted" />
      </div>
      <div className="space-y-1">
        <p className="text-sm font-semibold text-foreground">{title}</p>
        {message && (
          <p className="max-w-sm text-sm text-foreground-muted">{message}</p>
        )}
      </div>
      {action && (
        <Button variant="primary" size="sm" onClick={action.onClick}>
          {action.label}
        </Button>
      )}
    </div>
  );
}
