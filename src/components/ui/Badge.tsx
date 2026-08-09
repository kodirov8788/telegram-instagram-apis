import { HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

/**
 * Color roles reused across the app:
 * sky/brand = primary, emerald = AI-mode/success, rose = human-attention/error,
 * pink = Instagram channel, purple/amber = secondary/language indicators.
 */
export type BadgeTone =
  | "brand"
  | "success"
  | "error"
  | "warning"
  | "instagram"
  | "secondary"
  | "neutral";

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
}

const toneClasses: Record<BadgeTone, string> = {
  brand: "bg-brand-100 text-brand-700",
  success: "bg-emerald-100 text-emerald-700",
  error: "bg-rose-100 text-rose-700",
  warning: "bg-amber-100 text-amber-700",
  instagram: "bg-pink-100 text-pink-700",
  secondary: "bg-purple-100 text-purple-700",
  neutral: "bg-background-muted text-foreground-muted",
};

/**
 * Badge / StatusPill — small colored label for channel/status indicators.
 * Usage: <Badge tone="success">Active</Badge>  or  <Badge tone="instagram">Instagram</Badge>
 */
export function Badge({ className, tone = "neutral", ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
        toneClasses[tone],
        className
      )}
      {...props}
    />
  );
}

export { Badge as StatusPill };
