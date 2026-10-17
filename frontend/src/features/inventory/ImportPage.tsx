import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, CheckCircle2, Download, FileSpreadsheet, UploadCloud, XCircle } from "lucide-react";
import * as React from "react";
import { Link, useSearchParams } from "react-router-dom";
import { toast } from "sonner";

import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { KeyValue, PageHeader, Pagination } from "@/components/ui/data";
import { Callout, EmptyState, ErrorState, SkeletonRows, Spinner } from "@/components/ui/feedback";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAuth } from "@/features/auth/auth-context";
import { ConfirmDialog, GuardrailError, JobStatus } from "@/features/merchant-dashboard/components/common";
import { api, errorMessage } from "@/lib/api";
import { cn, downloadText, formatDateTime, formatNumber, uid } from "@/lib/utils";
import type { JobOut, Page } from "@/types/api";

import type { CommitResponse, ImportJob, ImportRow } from "./types";

const MAX_BYTES = 5 * 1024 * 1024;
const ALLOWED = [".csv", ".xlsx"];
const ROWS_PAGE = 20;
const KEY_FIELDS = ["product_id", "product_name", "store_id", "stock_quantity", "batch_id", "expiry_date", "price", "shelf_location"];

/** Client-side file check (extension and size). Returns an error message or null. */
export function checkImportFile(file: File): string | null {
  const name = file.name.toLowerCase();
  if (!ALLOWED.some((ext) => name.endsWith(ext))) return "Only .csv or .xlsx files are supported.";
  if (file.size === 0) return "The file is empty.";
  if (file.size > MAX_BYTES) return `The file is ${(file.size / 1024 / 1024).toFixed(1)} MB; the limit is 5 MB.`;
  return null;
}

export default function ImportPage() {
  const [params, setParams] = useSearchParams();
  const importId = params.get("id");
  const setImportId = (id: string | null) => {
    const next = new URLSearchParams(params);
    if (id) next.set("id", id);
    else next.delete("id");
    setParams(next, { replace: true });
  };

  return (
    <div>
      <PageHeader
        eyebrow="Inventory"
        title="Import inventory"
        description="Upload a CSV or XLSX file, review every row, then commit. Nothing changes until you commit."
        actions={
          <Button asChild variant="ghost">
            <Link to="/merchant/inventory">
              <ArrowLeft /> Back to inventory
            </Link>
          </Button>
        }
      />
      <Steps current={importId ? 3 : 1} />
      <Callout className="mb-4" title="How validation works">
        Every row is validated before anything is applied. Rows with errors are never applied (not even partially). Shelf locations are only set when they match a shelf in the store's active
        layout - locations are never invented; unmatched locations are reported as warnings and left unresolved.
      </Callout>
      {importId ? <ImportReview importId={importId} onReset={() => setImportId(null)} /> : <UploadStep onUploaded={(id) => setImportId(id)} />}
      <ImportHistory currentId={importId} onOpen={setImportId} />
    </div>
  );
}

function Steps({ current }: { current: number }) {
  const steps = ["Get the template", "Upload file", "Review & commit"];
  return (
    <ol className="mb-4 flex flex-wrap gap-2 text-sm" aria-label="Import steps">
      {steps.map((s, i) => {
        const n = i + 1;
        const state = n < current ? "done" : n === current ? "current" : "todo";
        return (
          <li
            key={s}
            aria-current={state === "current" ? "step" : undefined}
            className={cn(
              "flex items-center gap-2 rounded-full border px-3 py-1",
              state === "current" && "border-primary bg-primary-soft text-primary",
              state === "done" && "border-success/40 text-success",
              state === "todo" && "border-border text-muted-foreground",
            )}
          >
            <span className="tabular font-semibold">{n}</span> {s}
          </li>
        );
      })}
    </ol>
  );
}

function UploadStep({ onUploaded }: { onUploaded: (id: string) => void }) {
  const qc = useQueryClient();
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [file, setFile] = React.useState<File | null>(null);
  const [fileError, setFileError] = React.useState<string | null>(null);
  const [dragging, setDragging] = React.useState(false);

  const download = useMutation({
    mutationFn: async (kind: "template" | "sample") => ({ kind, text: await api.text(`/merchant/inventory/imports/${kind}`) }),
    onSuccess: ({ kind, text }) => downloadText(kind === "template" ? "omnipulse_inventory_template.csv" : "omnipulse_sample_import.csv", text),
    onError: (e) => toast.error(errorMessage(e)),
  });

  const upload = useMutation({
    mutationFn: (f: File) => {
      const fd = new FormData();
      fd.append("file", f);
      return api.upload<ImportJob>("/merchant/inventory/imports", fd, { "Idempotency-Key": uid() });
    },
    onSuccess: (job) => {
      toast.success(`Validated ${job.filename}`, { description: `${job.valid_rows} valid, ${job.error_rows} with errors` });
      void qc.invalidateQueries({ queryKey: ["merchant", "inventory", "imports"] });
      onUploaded(job.id);
    },
  });

  const choose = (f: File | undefined | null) => {
    if (!f) return;
    const err = checkImportFile(f);
    setFileError(err);
    setFile(err ? null : f);
    upload.reset();
  };

  return (
    <div className="mb-6 grid gap-4 lg:grid-cols-3">
      <Card>
        <CardHeader>
          <CardTitle>1. Get the template</CardTitle>
          <CardDescription>Required columns: product_id (SKU), store_id (store code), stock_quantity.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          <Button variant="outline" className="w-full" onClick={() => download.mutate("template")} loading={download.isPending && download.variables === "template"}>
            <Download /> Download template
          </Button>
          <Button variant="outline" className="w-full" onClick={() => download.mutate("sample")} loading={download.isPending && download.variables === "sample"}>
            <FileSpreadsheet /> Download sample file
          </Button>
          <p className="text-xs text-muted-foreground">The sample contains deliberate errors (negative stock, bad dates, unknown store, foreign currency…) so you can see how validation reports them.</p>
        </CardContent>
      </Card>
      <Card className="lg:col-span-2">
        <CardHeader>
          <CardTitle>2. Upload your file</CardTitle>
          <CardDescription>CSV or XLSX, up to 5 MB.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div
            role="button"
            tabIndex={0}
            aria-label="Choose a file to upload, or drop it here"
            onClick={() => inputRef.current?.click()}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                inputRef.current?.click();
              }
            }}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              choose(e.dataTransfer.files?.[0]);
            }}
            className={cn(
              "flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed px-6 py-8 text-center transition-colors focus-visible:outline-2 focus-visible:outline-ring",
              dragging ? "border-primary bg-primary-soft" : "border-border-strong hover:bg-muted/50",
            )}
          >
            <UploadCloud className="size-6 text-muted-foreground" aria-hidden />
            <p className="text-sm">
              <span className="font-medium text-primary">Choose a file</span> or drag it here
            </p>
            {file && (
              <p className="text-xs text-muted-foreground">
                Selected: <span className="font-medium text-foreground">{file.name}</span> ({(file.size / 1024).toFixed(1)} KB)
              </p>
            )}
          </div>
          <input
            ref={inputRef}
            type="file"
            accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            className="sr-only"
            data-testid="import-file-input"
            aria-label="Inventory file"
            onChange={(e) => {
              choose(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
          {fileError && (
            <p role="alert" className="text-sm text-danger">
              {fileError}
            </p>
          )}
          {upload.error ? <UploadError error={upload.error} /> : null}
          <div className="flex justify-end">
            <Button onClick={() => file && upload.mutate(file)} disabled={!file} loading={upload.isPending}>
              Upload & validate
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function UploadError({ error }: { error: unknown }) {
  const details = (error as { details?: { missing?: string[]; expected?: string[] } }).details;
  return (
    <div>
      <GuardrailError error={error} />
      {details?.missing && (
        <p className="mt-2 text-xs text-muted-foreground">
          Missing: <span className="font-mono">{details.missing.join(", ")}</span>
          {details.expected && (
            <>
              <br />
              Expected columns: <span className="font-mono">{details.expected.join(", ")}</span>
            </>
          )}
        </p>
      )}
    </div>
  );
}

type RowFilter = "errors" | "warnings" | "valid";

function ImportReview({ importId, onReset }: { importId: string; onReset: () => void }) {
  const qc = useQueryClient();
  const { can } = useAuth();
  const canImport = can("inventory.import");
  const [only, setOnly] = React.useState<RowFilter>("errors");
  const [page, setPage] = React.useState(1);
  const [confirmCommit, setConfirmCommit] = React.useState(false);
  const [confirmCancel, setConfirmCancel] = React.useState(false);
  const [jobId, setJobId] = React.useState<string | null>(null);

  const job = useQuery({
    queryKey: ["merchant", "inventory", "import", importId],
    queryFn: () => api.get<ImportJob>(`/merchant/inventory/imports/${importId}`),
    refetchInterval: (q) => (q.state.data?.status === "committing" && !jobId ? 2000 : false),
  });
  const rows = useQuery({
    queryKey: ["merchant", "inventory", "import", importId, "rows", only, page],
    queryFn: () => api.get<Page<ImportRow>>(`/merchant/inventory/imports/${importId}/rows`, { only, page, page_size: ROWS_PAGE }),
    placeholderData: keepPreviousData,
  });

  // Default to the most useful tab once counts are known.
  const j = job.data;
  const initialised = React.useRef(false);
  React.useEffect(() => {
    if (!j || initialised.current) return;
    initialised.current = true;
    if (j.error_rows === 0) setOnly(j.warning_rows ? "warnings" : "valid");
  }, [j]);

  const refreshAll = React.useCallback(() => {
    void qc.invalidateQueries({ queryKey: ["merchant", "inventory"] });
    void qc.invalidateQueries({ queryKey: ["merchant", "catalog"] });
    void qc.invalidateQueries({ queryKey: ["merchant", "expiry"] });
    void qc.invalidateQueries({ queryKey: ["merchant", "overview"] });
  }, [qc]);

  const commit = useMutation({
    mutationFn: () => api.post<CommitResponse>(`/merchant/inventory/imports/${importId}/commit`),
    onSuccess: (r) => {
      setConfirmCommit(false);
      qc.setQueryData(["merchant", "inventory", "import", importId], r.import);
      if (r.job_id) {
        setJobId(r.job_id);
        toast.message("Import queued", { description: "Applying valid rows…" });
      } else {
        toast.success("This import was already committed");
        refreshAll();
      }
    },
  });
  const cancel = useMutation({
    mutationFn: () => api.post<ImportJob>(`/merchant/inventory/imports/${importId}/cancel`),
    onSuccess: (r) => {
      setConfirmCancel(false);
      qc.setQueryData(["merchant", "inventory", "import", importId], r);
      void qc.invalidateQueries({ queryKey: ["merchant", "inventory", "imports"] });
      toast.success("Import cancelled; nothing was applied");
    },
  });

  const onJobDone = React.useCallback(
    (done: JobOut) => {
      refreshAll();
      if (done.status === "succeeded") toast.success("Import committed");
      else toast.error("Import failed", { description: done.error ?? undefined });
    },
    [refreshAll],
  );

  if (job.isLoading) return <SkeletonRows rows={6} className="mb-6" />;
  if (job.isError) return <ErrorState error={job.error} onRetry={() => job.refetch()} className="mb-6" />;
  if (!j) return null;
  const s = j.summary ?? {};
  const completed = j.status === "completed";
  const counts: Record<RowFilter, number> = { errors: j.error_rows, warnings: j.warning_rows, valid: j.valid_rows };

  return (
    <div className="mb-6 space-y-4">
      <Card>
        <CardHeader className="flex-row flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2">
              <FileSpreadsheet className="size-4 text-muted-foreground" aria-hidden /> {j.filename}
              <StatusBadge status={j.status} />
            </CardTitle>
            <CardDescription>Uploaded {formatDateTime(j.created_at)}{j.committed_at ? ` · committed ${formatDateTime(j.committed_at)}` : ""}</CardDescription>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={onReset}>
              Upload another file
            </Button>
            {canImport && j.status === "validated" && (
              <>
                <Button variant="outline" onClick={() => setConfirmCancel(true)}>
                  Cancel import
                </Button>
                <Button onClick={() => setConfirmCommit(true)} disabled={j.valid_rows === 0}>
                  Commit {j.valid_rows} valid row{j.valid_rows === 1 ? "" : "s"}
                </Button>
              </>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Count label="Total rows" value={j.total_rows} />
            <Count label="Valid" value={j.valid_rows} tone="success" />
            <Count label="With errors" value={j.error_rows} tone={j.error_rows ? "danger" : undefined} />
            <Count label="With warnings" value={j.warning_rows} tone={j.warning_rows ? "warning" : undefined} />
          </div>
          {!completed && (
            <p className="text-sm text-muted-foreground">
              Committing would create {formatNumber(s.would_create_products ?? 0)} new product(s) and touch {formatNumber(s.rows_creating ?? 0)} new and {formatNumber(s.rows_updating ?? 0)} existing
              stock records.
            </p>
          )}
          {s.unknown_columns && s.unknown_columns.length > 0 && (
            <Callout tone="warning" title="Unknown columns ignored">
              <span className="font-mono">{s.unknown_columns.join(", ")}</span>
            </Callout>
          )}
          {s.previously_imported_at && (
            <Callout tone="warning" title="This exact file was imported before">
              An identical file was committed on {formatDateTime(s.previously_imported_at)}. Committing again re-applies the stock counts.
            </Callout>
          )}
          {j.error_message && <Callout tone="warning">{j.error_message}</Callout>}
          {jobId && <JobStatus jobId={jobId} label="Applying import" onDone={onJobDone} />}
          {j.status === "committing" && !jobId && <Spinner label="Import is being applied" />}
          {completed && (
            <div className="rounded-lg border border-success/30 bg-success-soft p-4">
              <p className="mb-2 flex items-center gap-2 font-medium text-success">
                <CheckCircle2 className="size-4" aria-hidden /> Import applied
              </p>
              <KeyValue
                items={[
                  ["Products created", formatNumber(s.products_created ?? 0)],
                  ["Products updated", formatNumber(s.products_updated ?? 0)],
                  ["Batches created", formatNumber(s.batches_created ?? 0)],
                  ["Batches updated", formatNumber(s.batches_updated ?? 0)],
                  ["Shelf placements set", formatNumber(s.placements_set ?? 0)],
                  ["Net units change", `${(s.units_delta ?? 0) > 0 ? "+" : ""}${formatNumber(s.units_delta ?? 0)}`],
                  ["Rows skipped (errors)", formatNumber(j.error_rows)],
                ]}
              />
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Row review</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <Tabs
            value={only}
            onValueChange={(v) => {
              setOnly(v as RowFilter);
              setPage(1);
            }}
          >
            <TabsList>
              <TabsTrigger value="errors">
                <XCircle className="text-danger" /> Errors ({counts.errors})
              </TabsTrigger>
              <TabsTrigger value="warnings">Warnings ({counts.warnings})</TabsTrigger>
              <TabsTrigger value="valid">
                <CheckCircle2 className="text-success" /> Valid ({counts.valid})
              </TabsTrigger>
            </TabsList>
          </Tabs>
          {rows.isLoading ? (
            <SkeletonRows rows={5} />
          ) : rows.isError ? (
            <ErrorState error={rows.error} onRetry={() => rows.refetch()} />
          ) : !rows.data || rows.data.items.length === 0 ? (
            <EmptyState title={only === "errors" ? "No rows with errors" : only === "warnings" ? "No rows with warnings" : "No valid rows"} />
          ) : (
            <>
              <div className="rounded-md border border-border">
                <Table className={cn(rows.isPlaceholderData && "opacity-60")}>
                  <THead>
                    <TR>
                      <TH>Row</TH>
                      <TH>Action</TH>
                      {KEY_FIELDS.map((f) => (
                        <TH key={f}>{f}</TH>
                      ))}
                      <TH>Messages</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {rows.data.items.map((r) => {
                      const badFields = new Set(r.errors.map((e) => e.field));
                      const warnFields = new Set(r.warnings.map((e) => e.field));
                      return (
                        <TR key={r.row_number}>
                          <TD className="tabular font-medium">{r.row_number}</TD>
                          <TD>
                            <Badge variant={r.action === "create" ? "accent" : r.action === "update" ? "info" : "neutral"}>{r.action}</Badge>
                          </TD>
                          {KEY_FIELDS.map((f) => (
                            <TD
                              key={f}
                              className={cn("max-w-40 truncate font-mono text-xs", badFields.has(f) && "bg-danger-soft text-danger", !badFields.has(f) && warnFields.has(f) && "bg-warning-soft text-warning")}
                              title={r.raw[f]}
                            >
                              {r.raw[f] || <span className="text-muted-foreground">·</span>}
                            </TD>
                          ))}
                          <TD className="min-w-64">
                            <ul className="space-y-0.5 text-xs">
                              {r.errors.map((e, i) => (
                                <li key={`e${i}`} className="text-danger">
                                  <span className="font-mono font-medium">{e.field}</span>: {e.message}
                                </li>
                              ))}
                              {r.warnings.map((w, i) => (
                                <li key={`w${i}`} className="text-warning">
                                  <span className="font-mono font-medium">{w.field}</span>: {w.message}
                                </li>
                              ))}
                              {r.errors.length === 0 && r.warnings.length === 0 && <li className="text-success">OK</li>}
                            </ul>
                          </TD>
                        </TR>
                      );
                    })}
                  </TBody>
                </Table>
              </div>
              <Pagination page={page} pageSize={ROWS_PAGE} total={rows.data.total} onPage={setPage} />
            </>
          )}
        </CardContent>
      </Card>

      <ConfirmDialog
        open={confirmCommit}
        onOpenChange={setConfirmCommit}
        title="Commit this import?"
        description={`${j.valid_rows} valid row(s) will be applied to stock and catalog. ${j.error_rows} row(s) with errors will be skipped. This cannot be undone automatically.`}
        confirmLabel="Commit import"
        loading={commit.isPending}
        error={commit.error}
        onConfirm={() => commit.mutate()}
      />
      <ConfirmDialog
        open={confirmCancel}
        onOpenChange={setConfirmCancel}
        title="Cancel this import?"
        description="The staged rows will be discarded. Nothing has been applied."
        confirmLabel="Cancel import"
        destructive
        loading={cancel.isPending}
        error={cancel.error}
        onConfirm={() => cancel.mutate()}
      />
    </div>
  );
}

function Count({ label, value, tone }: { label: string; value: number; tone?: "success" | "danger" | "warning" }) {
  return (
    <div className="rounded-md border border-border p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={cn("tabular text-xl font-semibold", tone === "success" && "text-success", tone === "danger" && "text-danger", tone === "warning" && "text-warning")}>{formatNumber(value)}</p>
    </div>
  );
}

function ImportHistory({ currentId, onOpen }: { currentId: string | null; onOpen: (id: string) => void }) {
  const q = useQuery({ queryKey: ["merchant", "inventory", "imports"], queryFn: () => api.get<ImportJob[]>("/merchant/inventory/imports") });
  return (
    <Card>
      <CardHeader>
        <CardTitle>Import history</CardTitle>
        <CardDescription>The 50 most recent imports.</CardDescription>
      </CardHeader>
      <CardContent className="px-0">
        {q.isLoading ? (
          <SkeletonRows rows={3} className="px-5" />
        ) : q.isError ? (
          <ErrorState error={q.error} onRetry={() => q.refetch()} className="mx-5" />
        ) : !q.data?.length ? (
          <EmptyState title="No imports yet" className="mx-5" />
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>File</TH>
                <TH>Status</TH>
                <TH className="text-right">Rows</TH>
                <TH className="text-right">Valid</TH>
                <TH className="text-right">Errors</TH>
                <TH>Uploaded</TH>
                <TH>Committed</TH>
                <TH className="sr-only">Open</TH>
              </TR>
            </THead>
            <TBody>
              {q.data.map((j) => (
                <TR key={j.id} data-selected={j.id === currentId}>
                  <TD className="font-medium">{j.filename}</TD>
                  <TD>
                    <StatusBadge status={j.status} />
                  </TD>
                  <TD className="tabular text-right">{j.total_rows}</TD>
                  <TD className="tabular text-right">{j.valid_rows}</TD>
                  <TD className={cn("tabular text-right", j.error_rows > 0 && "text-danger")}>{j.error_rows}</TD>
                  <TD className="whitespace-nowrap text-xs text-muted-foreground">{formatDateTime(j.created_at)}</TD>
                  <TD className="whitespace-nowrap text-xs text-muted-foreground">{formatDateTime(j.committed_at)}</TD>
                  <TD className="text-right">
                    <Button variant="ghost" size="sm" onClick={() => onOpen(j.id)} disabled={j.id === currentId}>
                      Review
                    </Button>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
