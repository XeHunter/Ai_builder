/** Card chrome and navigation footer shared by every setup step. */
import { ArrowLeft, ArrowRight, Check } from "lucide-react";
import * as React from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { cn, formatNumber } from "@/lib/utils";

export interface StepNav {
  onBack?: () => void;
  onNext: () => void;
}

interface StepShellProps extends StepNav {
  title: string;
  description: React.ReactNode;
  done: boolean;
  /** When false the step cannot be skipped (Continue stays disabled until done). */
  skippable?: boolean;
  nextLabel?: string;
  children: React.ReactNode;
}

export function StepShell({ title, description, done, skippable = true, nextLabel = "Continue", onBack, onNext, children }: StepShellProps) {
  const headingId = React.useId();
  return (
    <Card aria-labelledby={headingId} role="region">
      <CardHeader>
        <CardTitle id={headingId} className="flex flex-wrap items-center gap-2">
          {title}
          {done && (
            <span className="inline-flex items-center gap-1 rounded-full bg-success-soft px-2 py-0.5 text-xs font-medium text-success">
              <Check className="size-3" aria-hidden /> Done
            </span>
          )}
        </CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">{children}</CardContent>
      <CardFooter className="flex-wrap justify-between">
        {onBack ? (
          <Button variant="ghost" onClick={onBack}>
            <ArrowLeft /> Back
          </Button>
        ) : (
          <span />
        )}
        {done ? (
          <Button onClick={onNext}>
            {nextLabel} <ArrowRight />
          </Button>
        ) : (
          <Button variant="outline" onClick={onNext} disabled={!skippable}>
            {skippable ? "Skip for now" : nextLabel} <ArrowRight />
          </Button>
        )}
      </CardFooter>
    </Card>
  );
}

/** Small labelled number tile (validation counts, import results, layout stats). */
export function Count({ label, value, tone }: { label: string; value: number | string; tone?: "success" | "danger" | "warning" }) {
  return (
    <div className="rounded-md border border-border p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={cn("tabular text-xl font-semibold", tone === "success" && "text-success", tone === "danger" && "text-danger", tone === "warning" && "text-warning")}>
        {typeof value === "number" ? formatNumber(value) : value}
      </p>
    </div>
  );
}
