import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Download, FileSpreadsheet, PackagePlus, UploadCloud } from "lucide-react";
import * as React from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";

import { StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Callout, Spinner } from "@/components/ui/feedback";
import type { CommitResponse, ImportJob } from "@/features/inventory/types";
import { api, errorMessage } from "@/lib/api";
import { downloadText, formatNumber, uid } from "@/lib/utils";

import { Count, StepShell, type StepNav } from "../components/StepShell";
import { csvForm, useRefreshSetup } from "../onboarding-api";

const importKey = (id: string | null) => ["merchant", "inventory", "import", id] as const;

interface Props extends StepNav {
  storeId: string;
  storeCode?: string;
  done: boolean;
  /** The store has an active floor plan (the starter catalog assigns shelf locations from it). */
  hasLayout: boolean;
  counts?: { products: number; stocked_items: number };
}

const REQUIRED = ["product_id", "store_id", "stock_quantity"];
const OPTIONAL = ["product_name", "category", "price", "cost_price", "batch_id", "expiry_date", "shelf_location"];

export function CatalogStep({ storeId, storeCode, done, hasLayout, counts, onBack, onNext }: Props) {
  const qc = useQueryClient();
  const refresh = useRefreshSetup();
  const [importId, setImportId] = React.useState<string | null>(null);
  const [committing, setCommitting] = React.useState(false);
  const finished = React.useRef<string | null>(null);

  const starterCsv = () => api.text(`/merchant/stores/${storeId}/starter-catalog.csv`);

  const download = useMutation({
    mutationFn: starterCsv,
    onSuccess: (text) => downloadText(`${storeCode ?? "store"}-starter-catalog.csv`, text),
    onError: (e) => toast.error(errorMessage(e)),
  });

  const upload = useMutation({
    mutationFn: async () => {
      const text = await starterCsv();
      return api.upload<ImportJob>("/merchant/inventory/imports", csvForm(text, `${storeCode ?? "store"}-starter-catalog.csv`), { "Idempotency-Key": uid() });
    },
    onSuccess: (job) => {
      finished.current = null;
      setCommitting(false);
      qc.setQueryData(importKey(job.id), job);
      setImportId(job.id);
      toast.success("Starter catalog validated", { description: `${job.valid_rows} valid, ${job.error_rows} with errors` });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const job = useQuery({
    queryKey: importKey(importId),
    queryFn: () => api.get<ImportJob>(`/merchant/inventory/imports/${importId}`),
    enabled: Boolean(importId),
    refetchInterval: (q) => (committing && !["completed", "failed", "cancelled"].includes(q.state.data?.status ?? "") ? 1500 : false),
  });
  const j = job.data;

  const commit = useMutation({
    mutationFn: () => api.post<CommitResponse>(`/merchant/inventory/imports/${importId}/commit`),
    onSuccess: (r) => {
      qc.setQueryData(importKey(r.import.id), r.import);
      setCommitting(true);
      if (r.job_id) toast.message("Adding products and stock…");
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  // Report once when the commit finishes.
  React.useEffect(() => {
    if (!j || !committing || finished.current === j.id) return;
    if (j.status === "completed") {
      finished.current = j.id;
      toast.success("Products and stock added");
      refresh(["merchant", "inventory"], ["merchant", "catalog"], ["merchant", "expiry"], ["merchant", "overview"]);
    } else if (j.status === "failed") {
      finished.current = j.id;
      toast.error("Import failed", { description: j.error_message ?? undefined });
    }
  }, [j, committing, refresh]);

  const status = j?.status;

  return (
    <StepShell
      title="Products & stock"
      description="Add the products you sell with their stock, prices and expiry dates. Any billing or ERP export works once its columns are mapped to the import template."
      done={done}
      onBack={onBack}
      onNext={onNext}
    >
      {counts && (counts.products > 0 || counts.stocked_items > 0) && (
        <p className="text-sm text-muted-foreground">
          You have {formatNumber(counts.products)} products and {formatNumber(counts.stocked_items)} items in stock.
        </p>
      )}
      <Callout title="Import format">
        One row per product (and batch) per store. Required columns: <span className="font-mono text-xs">{REQUIRED.join(", ")}</span>; useful extras:{" "}
        <span className="font-mono text-xs">{OPTIONAL.join(", ")}</span>. product_id is your SKU, store_id is your store code
        {storeCode ? <> (<span className="font-mono">{storeCode}</span>)</> : null} and shelf_location must match a shelf on your floor plan. Export from
        your billing or ERP system, rename the columns to match, and upload.
      </Callout>
      {!hasLayout && (
        <Callout tone="warning" title="Create the floor plan first">
          The starter catalog places every product on a shelf of your floor plan, so it needs an active floor plan for this store.
        </Callout>
      )}
      <div className="grid gap-3 md:grid-cols-2">
        <div className="flex flex-col gap-3 rounded-lg border border-border p-4">
          <div className="flex items-center gap-2 font-medium">
            <PackagePlus className="size-4 text-primary" aria-hidden /> Use the starter catalog
          </div>
          <p className="text-sm text-muted-foreground">60 common grocery products with stock, prices, expiry dates and shelf locations on your new floor plan.</p>
          <div className="mt-auto flex flex-wrap gap-2">
            <Button onClick={() => upload.mutate()} loading={upload.isPending} disabled={!hasLayout || status === "committing"}>
              <UploadCloud /> Use the starter catalog (60 grocery products)
            </Button>
            <Button variant="ghost" onClick={() => download.mutate()} loading={download.isPending} disabled={!hasLayout}>
              <Download /> Download starter CSV
            </Button>
          </div>
        </div>
        <div className="flex flex-col gap-3 rounded-lg border border-border p-4">
          <div className="flex items-center gap-2 font-medium">
            <FileSpreadsheet className="size-4 text-primary" aria-hidden /> Upload my own file
          </div>
          <p className="text-sm text-muted-foreground">CSV or XLSX up to 5 MB. Every row is validated and you review errors before anything is applied.</p>
          <Button asChild variant="outline" className="mt-auto self-start">
            <Link to="/merchant/inventory/import">Open inventory import</Link>
          </Button>
        </div>
      </div>

      {j && (
        <div className="space-y-3 rounded-lg border border-border p-4" aria-live="polite">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="flex items-center gap-2 font-medium">
              <FileSpreadsheet className="size-4 text-muted-foreground" aria-hidden /> {j.filename} <StatusBadge status={j.status} />
            </p>
            {j.status === "validated" && (
              <Button onClick={() => commit.mutate()} loading={commit.isPending} disabled={j.valid_rows === 0}>
                Add {j.valid_rows} valid row{j.valid_rows === 1 ? "" : "s"}
              </Button>
            )}
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Count label="Total rows" value={j.total_rows} />
            <Count label="Valid" value={j.valid_rows} tone="success" />
            <Count label="With errors" value={j.error_rows} tone={j.error_rows ? "danger" : undefined} />
            <Count label="With warnings" value={j.warning_rows} tone={j.warning_rows ? "warning" : undefined} />
          </div>
          {j.error_rows > 0 && j.status === "validated" && (
            <p className="text-sm text-muted-foreground">
              Rows with errors are skipped.{" "}
              <Link to={`/merchant/inventory/import?id=${j.id}`} className="font-medium text-primary hover:underline">
                Review them row by row
              </Link>
              .
            </p>
          )}
          {j.status === "committing" && <Spinner label="Adding products and stock" />}
          {j.status === "completed" && (
            <p className="flex items-center gap-2 text-sm font-medium text-success">
              <CheckCircle2 className="size-4" aria-hidden /> Catalog and stock are in. {formatNumber(j.summary?.products_created ?? 0)} products created.
            </p>
          )}
          {j.status === "failed" && j.error_message && <Callout tone="warning">{j.error_message}</Callout>}
        </div>
      )}
    </StepShell>
  );
}
