import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";

import { cn } from "@/lib/utils";

const badgeVariants = cva("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap", {
  variants: {
    variant: {
      neutral: "bg-muted text-muted-foreground",
      primary: "bg-primary-soft text-primary",
      success: "bg-success-soft text-success",
      warning: "bg-warning-soft text-warning",
      danger: "bg-danger-soft text-danger",
      info: "bg-info-soft text-info",
      accent: "bg-accent-soft text-accent",
      outline: "border border-border-strong text-foreground",
    },
  },
  defaultVariants: { variant: "neutral" },
});

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export type BadgeVariant = NonNullable<BadgeProps["variant"]>;

const STATUS: Record<string, BadgeVariant> = {
  RECOMMENDED: "info", PENDING_APPROVAL: "warning", APPROVED: "accent", PUBLISHED: "success", REJECTED: "neutral",
  CANCELLED: "neutral", EXPIRED: "neutral", FAILED: "danger",
  draft: "neutral", pending_approval: "warning", scheduled: "info", active: "success", paused: "warning", ended: "neutral",
  rejected: "neutral", cancelled: "neutral", proposed: "info", accepted: "accent", implemented: "success", completed: "success",
  open: "danger", in_review: "warning", escalated: "accent", closed: "neutral", queued: "neutral", running: "info",
  succeeded: "success", failed: "danger", validated: "info", committing: "warning", archived: "neutral",
  high: "danger", medium: "warning", low: "info", none: "neutral", critical: "danger", warning: "warning", expired: "neutral",
  in_stock: "success", low_stock: "warning", out_of_stock: "danger", collected: "success", pending: "neutral",
  unavailable: "warning", unresolved: "danger", acknowledged: "info", resolved: "success", done: "success",
  confirmed_fraud: "danger", false_positive: "success", inconclusive: "neutral",
};

export function statusVariant(status: string): BadgeVariant {
  return STATUS[status] ?? "neutral";
}

/** Consistent colour and label for any workflow/status value used across the app. */
export function StatusBadge({ status, className }: { status: string; className?: string }) {
  const label = status.replace(/_/g, " ").toLowerCase();
  return (
    <Badge variant={statusVariant(status)} className={className}>
      {label.charAt(0).toUpperCase() + label.slice(1)}
    </Badge>
  );
}
