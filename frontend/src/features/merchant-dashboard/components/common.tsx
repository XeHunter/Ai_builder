/** Small building blocks shared by the merchant operations pages (dashboard, inventory, expiry, pricing). */
import { CheckCircle2, ChevronDown, ChevronRight, XCircle } from "lucide-react";
import * as React from "react";
import { z } from "zod";

import { StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Field, Textarea } from "@/components/ui/input";
import { useJob } from "@/hooks/use-job";
import { ApiError, errorMessage } from "@/lib/api";
import { cn, formatDateTime, titleCase } from "@/lib/utils";
import type { JobOut } from "@/types/api";

// ---------------------------------------------------------------- hooks

export function useDebouncedValue<T>(value: T, ms = 300): T {
  const [v, setV] = React.useState(value);
  React.useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

// ---------------------------------------------------------------- zod helpers (RHF `valueAsNumber` yields NaN for empty inputs)

const nanToUndefined = (v: unknown) => (typeof v === "number" && Number.isNaN(v) ? undefined : v === "" ? undefined : v);

/** Required number field. */
export const zNum = (msg = "Enter a number") => z.number({ error: msg });

/** Optional number field: empty input becomes undefined. */
export const zOptNum = <T extends z.ZodTypeAny>(inner: T) => z.preprocess(nanToUndefined, inner.optional());

// ---------------------------------------------------------------- guardrail errors

export interface GuardrailProductIssue {
  product_id?: string;
  sku?: string;
  name: string;
  promo_price?: number;
  floor_price?: number;
  problems: string[];
}

/** Extracts guardrail violation messages from a backend 422 error, if any. */
export function guardrailDetails(err: unknown): { violations: string[]; products: GuardrailProductIssue[] } {
  if (!(err instanceof ApiError)) return { violations: [], products: [] };
  const d = (err.details ?? {}) as { violations?: unknown; products?: unknown };
  return {
    violations: Array.isArray(d.violations) ? (d.violations as string[]) : [],
    products: Array.isArray(d.products) ? (d.products as GuardrailProductIssue[]) : [],
  };
}

export function GuardrailError({ error, className }: { error: unknown; className?: string }) {
  if (!error) return null;
  const { violations, products } = guardrailDetails(error);
  const message = error instanceof ApiError ? error.message : errorMessage(error);
  return (
    <div role="alert" className={cn("rounded-lg border border-danger/30 bg-danger-soft p-3 text-sm", className)}>
      <p className="flex items-center gap-2 font-medium text-danger">
        <XCircle className="size-4" aria-hidden /> {message}
      </p>
      {violations.length > 0 && (
        <ul className="mt-2 list-disc space-y-0.5 pl-6 text-foreground/85">
          {violations.map((v) => (
            <li key={v}>{v}</li>
          ))}
        </ul>
      )}
      {products.length > 0 && (
        <ul className="mt-2 space-y-1 text-foreground/85">
          {products.map((p) => (
            <li key={p.product_id ?? p.name}>
              <span className="font-medium">{p.name}</span>
              {p.sku && <span className="text-muted-foreground"> ({p.sku})</span>}: {p.problems.join(" ")}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- confirm dialog

interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  confirmLabel?: string;
  destructive?: boolean;
  loading?: boolean;
  /** Show a note textarea; the note is passed to onConfirm. */
  withNote?: boolean;
  noteLabel?: string;
  noteRequired?: boolean;
  error?: unknown;
  children?: React.ReactNode;
  onConfirm: (note: string) => void;
}

/** Confirmation step for destructive or irreversible actions (reject, cancel, commit…). */
export function ConfirmDialog({
  open, onOpenChange, title, description, confirmLabel = "Confirm", destructive, loading, withNote, noteLabel = "Note",
  noteRequired, error, children, onConfirm,
}: ConfirmDialogProps) {
  const [note, setNote] = React.useState("");
  const [touched, setTouched] = React.useState(false);
  const id = React.useId();
  React.useEffect(() => {
    if (open) {
      setNote("");
      setTouched(false);
    }
  }, [open]);
  const noteMissing = Boolean(withNote && noteRequired && note.trim().length < 3);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={title} description={description} size="sm">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setTouched(true);
            if (!noteMissing) onConfirm(note.trim());
          }}
          className="space-y-3"
        >
          {children}
          {withNote && (
            <Field label={noteLabel} htmlFor={id} error={touched && noteMissing ? "Please give a short reason (3+ characters)" : undefined}>
              <Textarea id={id} value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} aria-invalid={touched && noteMissing} />
            </Field>
          )}
          {error ? <GuardrailError error={error} /> : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={loading}>
              Back
            </Button>
            <Button type="submit" variant={destructive ? "destructive" : "default"} loading={loading}>
              {confirmLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------- background job status

export function summarizeResult(result: Record<string, unknown> | null | undefined): string {
  if (!result) return "";
  return Object.entries(result)
    .filter(([, v]) => v === null || ["string", "number", "boolean"].includes(typeof v))
    .slice(0, 6)
    .map(([k, v]) => `${titleCase(k).toLowerCase()}: ${v}`)
    .join(" · ");
}

/** Polls a job and shows its status; calls `onDone` once when it finishes. */
export function JobStatus({ jobId, label = "Background job", onDone, className }: { jobId: string | null; label?: string; onDone?: (job: JobOut) => void; className?: string }) {
  const q = useJob(jobId);
  const job = q.data;
  const doneRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (job && ["succeeded", "failed"].includes(job.status) && doneRef.current !== job.id) {
      doneRef.current = job.id;
      onDone?.(job);
    }
  }, [job, onDone]);
  if (!jobId) return null;
  return (
    <div className={cn("flex flex-wrap items-center gap-2 rounded-md border border-border bg-surface-raised px-3 py-2 text-sm", className)} role="status" aria-live="polite">
      <span className="font-medium">{label}</span>
      <StatusBadge status={job?.status ?? "queued"} />
      {job?.status === "succeeded" && <CheckCircle2 className="size-4 text-success" aria-hidden />}
      {job?.error && <span className="text-danger">{job.error}</span>}
      {job?.status === "succeeded" && job.result && <span className="text-muted-foreground">{summarizeResult(job.result)}</span>}
      {job?.finished_at && <span className="text-xs text-muted-foreground">finished {formatDateTime(job.finished_at)}</span>}
    </div>
  );
}

// ---------------------------------------------------------------- filter chips

export function FilterChips<T extends string>({ options, value, onChange, label }: { options: { value: T; label: string }[]; value: T; onChange: (v: T) => void; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-1.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
            value === o.value ? "border-primary bg-primary-soft text-primary" : "border-border-strong bg-surface text-muted-foreground hover:bg-muted",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- JSON view

export function JsonBlock({ value, className }: { value: unknown; className?: string }) {
  return (
    <pre className={cn("max-h-72 overflow-auto rounded-md bg-muted p-3 font-mono text-xs leading-relaxed", className)}>
      {value === null || value === undefined ? "—" : JSON.stringify(value, null, 2)}
    </pre>
  );
}

export function Disclosure({ label, children, defaultOpen = false }: { label: React.ReactNode; children: React.ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = React.useState(defaultOpen);
  return (
    <div>
      <button type="button" className="inline-flex items-center gap-1 text-xs font-medium text-primary" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />} {label}
      </button>
      {open && <div className="mt-2">{children}</div>}
    </div>
  );
}

/** Small yes/no indicator used in check lists. */
export function Check({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1 text-xs", ok ? "text-success" : "text-danger")}>
      {ok ? <CheckCircle2 className="size-3.5" aria-hidden /> : <XCircle className="size-3.5" aria-hidden />}
      <span className="sr-only">{ok ? "Pass: " : "Fail: "}</span>
      {label}
    </span>
  );
}
