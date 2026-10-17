import { useMutation } from "@tanstack/react-query";
import { History, UploadCloud } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/feedback";
import { Label } from "@/components/ui/input";
import { api, errorMessage } from "@/lib/api";
import { formatNumber } from "@/lib/utils";

import { Count, StepShell, type StepNav } from "../components/StepShell";
import { csvForm, useRefreshSetup } from "../onboarding-api";
import type { SalesHistoryResult } from "../types";

const MAX_BYTES = 5 * 1024 * 1024;

/** Client-side check for a POS export: CSV, not empty, at most 5 MB. */
export function checkSalesFile(file: File): string | null {
  if (!file.name.toLowerCase().endsWith(".csv")) return "Only .csv files are supported for sales history.";
  if (file.size === 0) return "The file is empty.";
  if (file.size > MAX_BYTES) return `The file is ${(file.size / 1024 / 1024).toFixed(1)} MB; the limit is 5 MB.`;
  return null;
}

export const SALES_COLUMNS = ["receipt_number", "occurred_at", "store_id", "channel", "product_id", "quantity", "unit_price"];

interface Props extends StepNav {
  storeId: string;
  storeCode?: string;
  done: boolean;
  sales?: number;
}

export function HistoryStep({ storeId, storeCode, done, sales, onBack, onNext }: Props) {
  const refresh = useRefreshSetup();
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [fileError, setFileError] = React.useState<string | null>(null);
  const [result, setResult] = React.useState<SalesHistoryResult | null>(null);

  const onImported = (r: SalesHistoryResult) => {
    setResult(r);
    toast.success(`Imported ${formatNumber(r.receipts_imported)} bills`, { description: `${formatNumber(r.lines_imported)} line items` });
    refresh(["merchant", "overview"], ["merchant", "insights"]);
  };

  const sample = useMutation({
    mutationFn: async () => {
      const text = await api.text(`/merchant/stores/${storeId}/starter-sales.csv`, { days: 60, per_day: 40 });
      return api.upload<SalesHistoryResult>("/merchant/channels/sales-history", csvForm(text, `${storeCode ?? "store"}-sales-history.csv`));
    },
    onSuccess: onImported,
    onError: (e) => toast.error(errorMessage(e)),
  });

  const own = useMutation({
    mutationFn: (file: File) => {
      const fd = new FormData();
      fd.append("file", file);
      return api.upload<SalesHistoryResult>("/merchant/channels/sales-history", fd);
    },
    onSuccess: onImported,
    onError: (e) => toast.error(errorMessage(e)),
  });

  const choose = (f: File | undefined) => {
    if (!f) return;
    const err = checkSalesFile(f);
    setFileError(err);
    if (!err) own.mutate(f);
  };

  const busy = sample.isPending || own.isPending;

  return (
    <StepShell
      title="Sales history"
      description="Past bills teach the AI how your store sells: demand forecasting needs a few weeks of history, cross-selling learns which products are bought together, and fraud checks learn what normal looks like."
      done={done}
      onBack={onBack}
      onNext={onNext}
    >
      {sales !== undefined && sales > 0 && (
        <p className="text-sm text-muted-foreground">
          {formatNumber(sales)} sales records so far{sales < 200 ? " (at least 200 are recommended)." : "."}
        </p>
      )}
      <div className="grid gap-3 md:grid-cols-2">
        <div className="flex flex-col gap-3 rounded-lg border border-border p-4">
          <div className="flex items-center gap-2 font-medium">
            <History className="size-4 text-primary" aria-hidden /> Try it with sample sales
          </div>
          <p className="text-sm text-muted-foreground">About 40 bills a day for the last 60 days, generated over your own catalog. History only — stock is not changed.</p>
          <Button className="mt-auto self-start" onClick={() => sample.mutate()} loading={sample.isPending} disabled={busy}>
            Import 60 days of sample sales
          </Button>
        </div>
        <div className="flex flex-col gap-3 rounded-lg border border-border p-4">
          <div className="flex items-center gap-2 font-medium">
            <UploadCloud className="size-4 text-primary" aria-hidden /> Upload a POS export (CSV)
          </div>
          <p className="text-sm text-muted-foreground">
            One row per bill line with columns <span className="font-mono text-xs">{SALES_COLUMNS.join(", ")}</span>. Bills already imported are skipped.
          </p>
          <div className="mt-auto flex flex-col gap-1.5">
            <Label htmlFor="sales-file" className="sr-only">
              POS export file (CSV)
            </Label>
            <input
              ref={inputRef}
              id="sales-file"
              type="file"
              accept=".csv,text/csv"
              className="sr-only"
              onChange={(e) => {
                choose(e.target.files?.[0]);
                e.target.value = "";
              }}
            />
            <Button variant="outline" className="self-start" onClick={() => inputRef.current?.click()} loading={own.isPending} disabled={busy}>
              <UploadCloud /> Choose CSV file
            </Button>
            {fileError && (
              <p role="alert" className="text-sm text-danger">
                {fileError}
              </p>
            )}
          </div>
        </div>
      </div>

      {result && (
        <div className="space-y-3 rounded-lg border border-border p-4" aria-live="polite">
          <p className="font-medium">Import result</p>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Count label="Rows read" value={result.rows} />
            <Count label="Bills imported" value={result.receipts_imported} tone="success" />
            <Count label="Line items" value={result.lines_imported} />
            <Count label="Duplicate bills skipped" value={result.duplicate_receipts_skipped} tone={result.duplicate_receipts_skipped ? "warning" : undefined} />
          </div>
          {result.error_rows > 0 && (
            <Callout tone="warning" title={`${formatNumber(result.error_rows)} row(s) could not be imported`}>
              <ul className="mt-1 space-y-0.5 text-xs">
                {result.errors.slice(0, 10).map((e, i) => (
                  <li key={`${e.row}-${i}`}>
                    <span className="font-mono font-medium">Row {e.row}</span>: {e.message}
                  </li>
                ))}
                {result.errors.length > 10 && <li>…and {result.errors.length - 10} more</li>}
              </ul>
            </Callout>
          )}
        </div>
      )}
    </StepShell>
  );
}
