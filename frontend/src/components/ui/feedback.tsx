/** Loading, empty, error and informational states shared by every page. */
import { AlertTriangle, FlaskConical, Info, Inbox, Loader2, type LucideIcon } from "lucide-react";
import * as React from "react";

import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/api";
import { cn } from "@/lib/utils";

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("animate-pulse rounded-md bg-muted", className)} aria-hidden />;
}

export function SkeletonRows({ rows = 5, className }: { rows?: number; className?: string }) {
  return (
    <div className={cn("space-y-2", className)} aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className="h-10 w-full" />
      ))}
    </div>
  );
}

export function Spinner({ label = "Loading", className }: { label?: string; className?: string }) {
  return (
    <div role="status" className={cn("flex items-center gap-2 text-sm text-muted-foreground", className)}>
      <Loader2 className="size-4 animate-spin" aria-hidden />
      <span>{label}…</span>
    </div>
  );
}

interface EmptyStateProps {
  icon?: LucideIcon;
  title: string;
  description?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}

export function EmptyState({ icon: Icon = Inbox, title, description, action, className }: EmptyStateProps) {
  return (
    <div className={cn("flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border-strong px-6 py-10 text-center", className)}>
      <div className="rounded-full bg-muted p-3 text-muted-foreground">
        <Icon className="size-5" aria-hidden />
      </div>
      <div>
        <p className="font-medium">{title}</p>
        {description && <p className="mt-1 max-w-md text-sm text-muted-foreground">{description}</p>}
      </div>
      {action}
    </div>
  );
}

export function ErrorState({ error, onRetry, className }: { error: unknown; onRetry?: () => void; className?: string }) {
  return (
    <div role="alert" className={cn("flex flex-col items-start gap-3 rounded-lg border border-danger/30 bg-danger-soft p-4", className)}>
      <div className="flex items-center gap-2 font-medium text-danger">
        <AlertTriangle className="size-4" aria-hidden /> Could not load this data
      </div>
      <p className="text-sm text-foreground/80">{errorMessage(error)}</p>
      {onRetry && (
        <Button size="sm" variant="outline" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}

type CalloutTone = "info" | "warning" | "simulated";

/** Inline note. The "simulated" tone is used wherever data or integrations are simulated. */
export function Callout({ tone = "info", title, children, className }: { tone?: CalloutTone; title?: string; children: React.ReactNode; className?: string }) {
  const styles: Record<CalloutTone, string> = {
    info: "border-info/25 bg-info-soft text-info",
    warning: "border-warning/30 bg-warning-soft text-warning",
    simulated: "border-accent/25 bg-accent-soft text-accent",
  };
  const Icon = tone === "warning" ? AlertTriangle : tone === "simulated" ? FlaskConical : Info;
  return (
    <div className={cn("flex gap-3 rounded-lg border p-3 text-sm", styles[tone], className)}>
      <Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
      <div className="text-foreground/85">
        {title && <p className="font-medium text-foreground">{title}</p>}
        {children}
      </div>
    </div>
  );
}

export function Progress({ value, className, label }: { value: number; className?: string; label?: string }) {
  const v = Math.max(0, Math.min(100, value));
  return (
    <div className={cn("h-2 w-full overflow-hidden rounded-full bg-muted", className)} role="progressbar" aria-valuenow={v} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
      <div className="h-full rounded-full bg-primary transition-[width] duration-500" style={{ width: `${v}%` }} />
    </div>
  );
}
