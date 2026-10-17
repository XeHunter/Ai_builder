/**
 * Store layout & planogram editor.
 *
 * View the active layout read-only, create a draft (proposal) cloned from it, edit placements and movable
 * fixtures on the draft with server-side constraint checks, compare with the active layout, then publish
 * (shopper routes switch to it) or discard.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRightLeft, FilePlus2, GitCompare, LayoutGrid, Move, Package, Send, Trash2, X } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";

import { StoreMap, groupShelves, type ShelfSection } from "@/components/maps/StoreMap";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Callout, EmptyState, ErrorState, Skeleton } from "@/components/ui/feedback";
import { Field, Input, Select } from "@/components/ui/input";
import { PageHeader } from "@/components/ui/data";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { useAuth } from "@/features/auth/auth-context";
import { useMerchantStore } from "@/hooks/use-stores";
import { api, ApiError } from "@/lib/api";
import { cn, formatDate } from "@/lib/utils";
import type { Fixture, Layout, Shelf } from "@/types/api";

import { ConfirmDialog } from "./ConfirmDialog";
import { layoutKeys, plainError, useLayout, useStoreLayouts, violationsFrom, VIOLATION_LABEL } from "./layout-api";
import { PlacementRulesCard } from "./PlacementRulesCard";
import { ProductPicker } from "./ProductPicker";
import type { LayoutDiff, LayoutSummary, MerchantProduct, PlaceResult, Violation } from "./types";

type Feedback = { kind: "blocked" | "warnings" | "error"; title: string; items: Violation[]; message?: string } | null;

/** Shift a fixture and its shelves in cached layout data (optimistic fixture move). */
export function moveFixtureLocally(layout: Layout, fixtureId: string, to: { x: number; y: number }): Layout {
  const f = layout.fixtures.find((x) => x.id === fixtureId);
  if (!f) return layout;
  const dx = to.x - f.x;
  const dy = to.y - f.y;
  return {
    ...layout,
    fixtures: layout.fixtures.map((x) => (x.id === fixtureId ? { ...x, x: to.x, y: to.y } : x)),
    shelves: layout.shelves.map((s) => (s.fixture_id === fixtureId ? { ...s, x: s.x + dx, y: s.y + dy } : s)),
  };
}

export default function LayoutPage() {
  const { concreteStoreId, stores } = useMerchantStore();
  const { can } = useAuth();
  const canWrite = can("layout.write");
  const qc = useQueryClient();
  const storeName = stores.find((s) => s.id === concreteStoreId)?.name;

  const layouts = useStoreLayouts(concreteStoreId);
  const draft = layouts.data?.find((l) => l.status === "draft") ?? null;
  const active = layouts.data?.find((l) => l.status === "active") ?? null;
  const [chosenId, setChosenId] = React.useState<string | null>(null);
  const validChosen = chosenId && layouts.data?.some((l) => l.id === chosenId) ? chosenId : null;
  const layoutId = validChosen ?? draft?.id ?? active?.id ?? null;
  const layoutQ = useLayout(layoutId);
  const layout = layoutQ.data ?? null;
  const isDraft = layout?.status === "draft";
  const editable = isDraft && canWrite;

  const [sectionKey, setSectionKey] = React.useState<string | null>(null);
  const [product, setProduct] = React.useState<MerchantProduct | { id: string; name: string } | null>(null);
  const [fromShelf, setFromShelf] = React.useState<string>("");
  const [facings, setFacings] = React.useState(1);
  const [feedback, setFeedback] = React.useState<Feedback>(null);
  const [dropTarget, setDropTarget] = React.useState<{ section: ShelfSection; productId: string } | null>(null);
  const [confirm, setConfirm] = React.useState<"publish" | "discard" | null>(null);
  const [showDiff, setShowDiff] = React.useState(false);
  const [draftConflict, setDraftConflict] = React.useState<string | null>(null);

  // reset selections when the store changes
  React.useEffect(() => {
    setChosenId(null);
    setSectionKey(null);
    setFeedback(null);
  }, [concreteStoreId]);

  const sections = React.useMemo(() => (layout ? groupShelves(layout.shelves) : []), [layout]);
  const section = sections.find((s) => s.key === sectionKey) ?? null;

  const diffQ = useDiff(isDraft ? layoutId : null);
  const highlight = React.useMemo(() => diffQ.data?.changes.flatMap((c) => c.proposed) ?? [], [diffQ.data]);

  const invalidate = React.useCallback(() => {
    void qc.invalidateQueries({ queryKey: ["merchant", "layouts"] });
    void qc.invalidateQueries({ queryKey: ["merchant", "layout"] });
    void qc.invalidateQueries({ queryKey: ["merchant", "layout-diff"] });
  }, [qc]);

  // shelves where the selected product currently sits (for "move from")
  const productShelves = React.useMemo(
    () => (layout && product ? layout.shelves.filter((s) => s.products.some((p) => p.product_id === product.id)) : []),
    [layout, product],
  );
  React.useEffect(() => {
    if (fromShelf && !productShelves.some((s) => s.code === fromShelf)) setFromShelf("");
  }, [productShelves, fromShelf]);

  const createDraft = useMutation({
    mutationFn: () => api.post<Layout>(`/merchant/stores/${concreteStoreId}/layouts/draft`),
    onSuccess: (d) => {
      toast.success(`Draft v${d.version} created from the active layout`);
      qc.setQueryData(layoutKeys.detail(d.id), d);
      setChosenId(d.id);
      setDraftConflict(null);
      invalidate();
    },
    onError: (err) => {
      const existing = err instanceof ApiError ? (err.details as { draft_layout_id?: string } | null)?.draft_layout_id : undefined;
      if (existing) {
        setDraftConflict(existing);
        toast.error("A draft already exists for this store", { action: { label: "Open draft", onClick: () => setChosenId(existing) } });
      } else toast.error(plainError(err));
    },
  });

  const place = useMutation({
    mutationFn: (v: { product_id: string; shelf_code: string; facings: number; from_shelf_code?: string }) =>
      api.post<PlaceResult>(`/merchant/layouts/${layoutId}/placements`, v),
    onSuccess: (res, v) => {
      const warns = res.warnings.filter((w) => w.severity === "warn");
      toast.success(`${v.from_shelf_code ? "Moved" : "Placed"} on ${res.shelf_code}`);
      setFeedback(warns.length ? { kind: "warnings", title: `Placed on ${res.shelf_code} with warnings`, items: warns } : null);
      setFromShelf("");
      invalidate();
    },
    onError: (err, v) => {
      const items = violationsFrom(err);
      if (items.length) {
        setFeedback({ kind: "blocked", title: `Cannot place on ${v.shelf_code}`, items, message: plainError(err) });
        toast.error("Placement blocked by merchandising constraints");
      } else {
        setFeedback({ kind: "error", title: `Cannot place on ${v.shelf_code}`, items: [], message: plainError(err) });
        toast.error(plainError(err));
      }
    },
  });

  const remove = useMutation({
    mutationFn: (placementId: string) => api.delete(`/merchant/layouts/${layoutId}/placements/${placementId}`),
    onSuccess: () => {
      toast.success("Placement removed from the draft");
      invalidate();
    },
    onError: (err) => toast.error(plainError(err)),
  });

  const moveFixture = useMutation({
    mutationFn: (v: { fixture: Fixture; to: { x: number; y: number } }) =>
      api.patch(`/merchant/layouts/${layoutId}/fixtures/${v.fixture.id}`, v.to),
    onMutate: async (v) => {
      const key = layoutKeys.detail(layoutId);
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData<Layout>(key);
      if (prev) qc.setQueryData(key, moveFixtureLocally(prev, v.fixture.id, v.to));
      setSectionKey(null);
      return { prev };
    },
    onError: (err, v, ctx) => {
      if (ctx?.prev) qc.setQueryData(layoutKeys.detail(layoutId), ctx.prev);
      setFeedback({ kind: "error", title: `${v.fixture.label} was not moved`, items: [], message: plainError(err) });
      toast.error(`${v.fixture.label}: ${plainError(err)}`);
    },
    onSuccess: (_d, v) => {
      toast.success(`${v.fixture.label} moved to (${v.to.x}, ${v.to.y}) m`);
      setFeedback(null);
    },
    onSettled: () => invalidate(),
  });

  const publish = useMutation({
    mutationFn: () => api.post<{ id: string; version: number }>(`/merchant/layouts/${layoutId}/publish`),
    onSuccess: (r) => {
      toast.success(`Layout v${r.version} is now active. Shopper routes use it immediately.`);
      setConfirm(null);
      setChosenId(r.id);
      invalidate();
      void qc.invalidateQueries({ queryKey: ["store"] });
    },
    onError: (err) => toast.error(plainError(err)),
  });

  const discard = useMutation({
    mutationFn: () => api.delete(`/merchant/layouts/${layoutId}`),
    onSuccess: () => {
      toast.success("Draft discarded. The active layout is unchanged.");
      setConfirm(null);
      setChosenId(null);
      setSectionKey(null);
      // drop the deleted draft from the cached list first so no query refetches it (404)
      qc.setQueryData<LayoutSummary[]>(layoutKeys.list(concreteStoreId), (old) => old?.filter((l) => l.id !== layoutId));
      qc.removeQueries({ queryKey: layoutKeys.detail(layoutId) });
      qc.removeQueries({ queryKey: layoutKeys.diff(layoutId) });
      void qc.invalidateQueries({ queryKey: ["merchant", "layouts"] });
    },
    onError: (err) => toast.error(plainError(err)),
  });

  const doPlace = (shelfCode: string, productId: string, opts: { facings: number; from?: string }) => {
    setFeedback(null);
    place.mutate({ product_id: productId, shelf_code: shelfCode, facings: opts.facings, from_shelf_code: opts.from || undefined });
  };

  if (!concreteStoreId) {
    return (
      <>
        <PageHeader title="Store layout" />
        {stores.length === 0 ? <Skeleton className="h-96 w-full" /> : <EmptyState title="No store available" />}
      </>
    );
  }

  return (
    <>
      <PageHeader
        eyebrow="Merchandising"
        title="Store layout & planogram"
        description={`Floor plan and shelf placements for ${storeName ?? "the selected store"}. Edits happen on a draft proposal; the active layout drives shopper navigation until a draft is published.`}
        actions={
          canWrite && layout ? (
            isDraft ? (
              <>
                <Button variant="outline" onClick={() => setShowDiff(true)}>
                  <GitCompare /> Compare with active
                </Button>
                <Button variant="outline" onClick={() => setConfirm("discard")}>
                  <Trash2 /> Discard draft
                </Button>
                <Button onClick={() => setConfirm("publish")}>
                  <Send /> Publish draft
                </Button>
              </>
            ) : draft ? (
              <Button onClick={() => setChosenId(draft.id)}>
                <LayoutGrid /> Open draft v{draft.version}
              </Button>
            ) : (
              <Button onClick={() => createDraft.mutate()} loading={createDraft.isPending} disabled={!active}>
                <FilePlus2 /> Create proposal (draft)
              </Button>
            )
          ) : undefined
        }
      />

      <Callout title="Editor scope" className="mb-4">
        Aisle and wall fixtures and the walkway graph are fixed in this version. Only endcaps, displays and clearance bins
        (dashed outline) can be dragged, and the server rejects moves that leave less than 0.6 m clearance from walking
        routes, overlap another fixture or leave the floor. Product placements are checked for refrigeration, safe height
        for heavy items (≤ 100 cm), shelf capacity, and confectionery / children’s products at checkout or kids’ eye level.
        See <strong>Placement rules</strong> for the live check.
      </Callout>

      {draftConflict && draftConflict !== layoutId && (
        <Callout tone="warning" title="A draft already exists" className="mb-4">
          Publish or discard the existing draft before creating a new one.{" "}
          <Button variant="link" size="sm" onClick={() => setChosenId(draftConflict)}>
            Open the existing draft
          </Button>
        </Callout>
      )}

      {layouts.isError ? (
        <ErrorState error={layouts.error} onRetry={() => void layouts.refetch()} />
      ) : (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
          <div className="flex min-w-0 flex-col gap-4">
            <Card>
              <CardHeader className="flex-row flex-wrap items-center justify-between gap-2 pb-3">
                <div className="flex flex-wrap items-center gap-2">
                  <CardTitle>{layout ? layout.name : "Loading layout"}</CardTitle>
                  {layout && <StatusBadge status={layout.status} />}
                  {editable && <Badge variant="accent">Editing</Badge>}
                  {layout && !isDraft && <Badge variant="outline">Read-only</Badge>}
                </div>
                <VersionSwitcher layouts={layouts.data ?? []} value={layoutId} onChange={(id) => { setChosenId(id); setSectionKey(null); }} />
              </CardHeader>
              <CardContent>
                {layoutQ.isError ? (
                  <ErrorState error={layoutQ.error} onRetry={() => void layoutQ.refetch()} />
                ) : !layout ? (
                  layouts.data && !layouts.data.length ? (
                    <EmptyState icon={LayoutGrid} title="No layout for this store" description="Seed or import a floor plan first." />
                  ) : (
                    <Skeleton className="aspect-[4/3] w-full" />
                  )
                ) : (
                  <>
                    <StoreMap
                      layout={layout}
                      editable={editable}
                      highlight={highlight}
                      selectedShelfCode={sectionKey}
                      onSectionClick={(s) => setSectionKey(s.key)}
                      onShelfDrop={editable ? (s, data) => data && setDropTarget({ section: s, productId: data }) : undefined}
                      onFixtureMove={editable ? (fixture, to) => {
                        if (Math.abs(to.x - fixture.x) < 0.05 && Math.abs(to.y - fixture.y) < 0.05) return;
                        moveFixture.mutate({ fixture, to });
                      } : undefined}
                      ariaLabel={`Floor plan for ${layout.name}. Shelf sections are buttons; press Enter to inspect.`}
                    />
                    <p className="mt-2 text-xs text-muted-foreground">
                      {editable
                        ? "Drag a product from the palette onto a shelf dot, or select a section and use “Place here”. Drag dashed fixtures to move them."
                        : "Select a shelf section to see its levels and products."}
                      {highlight.length > 0 && " Highlighted shelves differ from the active layout."}
                    </p>
                  </>
                )}
              </CardContent>
            </Card>
            <FeedbackPanel feedback={feedback} onClose={() => setFeedback(null)} />
          </div>

          <div className="flex flex-col gap-4">
            <SectionInspector
              section={section}
              editable={editable}
              selectedProduct={product}
              busy={place.isPending || remove.isPending}
              onClose={() => setSectionKey(null)}
              onPlace={(shelf) => product && doPlace(shelf.code, product.id, { facings, from: fromShelf })}
              onRemove={(placementId) => remove.mutate(placementId)}
              onStartMove={(p, shelf) => {
                setProduct({ id: p.product_id, name: p.name });
                setFromShelf(shelf.code);
                toast.info(`Moving ${p.name} from ${shelf.code}: choose a target level`);
              }}
            />
            {editable && (
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Package className="size-4" aria-hidden /> Product palette
                  </CardTitle>
                  <CardDescription>Select or drag a product.</CardDescription>
                </CardHeader>
                <CardContent className="flex flex-col gap-3">
                  {product && (
                    <div className="rounded-md border border-primary/30 bg-primary-soft p-2 text-sm">
                      <div className="flex items-start justify-between gap-2">
                        <span>
                          Selected: <strong>{product.name}</strong>
                        </span>
                        <button type="button" aria-label="Clear selected product" onClick={() => { setProduct(null); setFromShelf(""); }}>
                          <X className="size-4 text-muted-foreground" />
                        </button>
                      </div>
                      <div className="mt-2 grid grid-cols-2 gap-2">
                        <Field label="Facings" htmlFor="facings">
                          <Input id="facings" type="number" min={1} max={12} value={facings}
                            onChange={(e) => setFacings(Math.min(12, Math.max(1, Number(e.target.value) || 1)))} />
                        </Field>
                        <Field label="Mode" htmlFor="from-shelf">
                          <Select id="from-shelf" value={fromShelf} onChange={(e) => setFromShelf(e.target.value)}>
                            <option value="">Add placement</option>
                            {productShelves.map((s) => (
                              <option key={s.id} value={s.code}>
                                Move from {s.code}
                              </option>
                            ))}
                          </Select>
                        </Field>
                      </div>
                    </div>
                  )}
                  <ProductPicker draggable selectedId={product?.id} onSelect={(p) => { setProduct(p); setFromShelf(""); }} />
                </CardContent>
              </Card>
            )}
            <PlacementRulesCard layoutId={layoutId} />
          </div>
        </div>
      )}

      <DropDialog
        target={dropTarget}
        productName={product && dropTarget && product.id === dropTarget.productId ? product.name : undefined}
        layout={layout}
        busy={place.isPending}
        onClose={() => setDropTarget(null)}
        onPlace={(code, opts) => {
          if (!dropTarget) return;
          doPlace(code, dropTarget.productId, opts);
          setSectionKey(dropTarget.section.key);
          setDropTarget(null);
        }}
      />

      <DiffDialog open={showDiff} onOpenChange={setShowDiff} diff={diffQ.data} loading={diffQ.isLoading} error={diffQ.error} />

      <ConfirmDialog
        open={confirm === "publish"}
        onOpenChange={(o) => !o && setConfirm(null)}
        title="Publish this draft?"
        description="The current active layout will be archived. Shopper navigation, product locations and routes switch to this layout immediately."
        confirmLabel="Publish layout"
        loading={publish.isPending}
        onConfirm={() => publish.mutate()}
      >
        <p className="text-sm text-muted-foreground">
          {diffQ.data ? `${diffQ.data.changes.length} product placement change(s) compared with the active layout.` : "Review the comparison before publishing."}
        </p>
      </ConfirmDialog>
      <ConfirmDialog
        open={confirm === "discard"}
        onOpenChange={(o) => !o && setConfirm(null)}
        title="Discard this draft?"
        description="All draft edits are deleted and the store keeps its active layout. This cannot be undone."
        confirmLabel="Discard draft"
        destructive
        loading={discard.isPending}
        onConfirm={() => discard.mutate()}
      />
    </>
  );
}

function useDiff(layoutId: string | null) {
  return useQuery({
    queryKey: layoutKeys.diff(layoutId),
    queryFn: () => api.get<LayoutDiff>(`/merchant/layouts/${layoutId}/diff`),
    enabled: Boolean(layoutId),
  });
}

function VersionSwitcher({ layouts, value, onChange }: { layouts: { id: string; version: number; status: string; published_at: string | null; created_at: string }[]; value: string | null; onChange: (id: string) => void }) {
  if (layouts.length <= 1) return null;
  return (
    <div className="flex items-center gap-2">
      <label htmlFor="layout-version" className="text-xs text-muted-foreground">
        Version
      </label>
      <Select id="layout-version" value={value ?? ""} onChange={(e) => onChange(e.target.value)} className="h-8 w-auto text-xs">
        {layouts.map((l) => (
          <option key={l.id} value={l.id}>
            v{l.version} · {l.status}
            {l.published_at ? ` · ${formatDate(l.published_at)}` : ` · ${formatDate(l.created_at)}`}
          </option>
        ))}
      </Select>
    </div>
  );
}

function FeedbackPanel({ feedback, onClose }: { feedback: Feedback; onClose: () => void }) {
  if (!feedback) return null;
  return (
    <div role="alert" aria-live="assertive">
      <Callout tone="warning" title={feedback.title}>
        {feedback.message && feedback.kind !== "warnings" && <p>{feedback.message}.</p>}
        {feedback.items.length > 0 && (
          <ul className="mt-1.5 flex flex-col gap-1">
            {feedback.items.map((v, i) => (
              <li key={i} className="flex flex-wrap items-center gap-2">
                <Badge variant={v.severity === "block" ? "danger" : "warning"}>{VIOLATION_LABEL[v.code] ?? v.code}</Badge>
                <span>{v.message}</span>
              </li>
            ))}
          </ul>
        )}
        <Button variant="link" size="sm" onClick={onClose} className="mt-1">
          Dismiss
        </Button>
      </Callout>
    </div>
  );
}

interface InspectorProps {
  section: ShelfSection | null;
  editable: boolean;
  selectedProduct: { id: string; name: string } | null;
  busy: boolean;
  onClose: () => void;
  onPlace: (shelf: Shelf) => void;
  onRemove: (placementId: string) => void;
  onStartMove: (p: Shelf["products"][number], shelf: Shelf) => void;
}

function SectionInspector({ section, editable, selectedProduct, busy, onClose, onPlace, onRemove, onStartMove }: InspectorProps) {
  if (!section) {
    return (
      <Card>
        <CardContent className="pt-5">
          <EmptyState icon={LayoutGrid} title="No section selected" description="Click or tab to a shelf dot on the map to inspect its levels." />
        </CardContent>
      </Card>
    );
  }
  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-2">
        <div>
          <CardTitle>Section {section.label}</CardTitle>
          <CardDescription>
            {section.shelves.length} level{section.shelves.length === 1 ? "" : "s"} · top to bottom
          </CardDescription>
        </div>
        <Button variant="ghost" size="icon" aria-label="Close inspector" onClick={onClose}>
          <X />
        </Button>
      </CardHeader>
      <CardContent>
        <ol className="flex flex-col gap-2" aria-label={`Levels of section ${section.label}`}>
          {section.shelves.map((sh) => {
            const used = sh.products.reduce((n, p) => n + p.facings, 0);
            return (
              <li key={sh.id} className="rounded-md border border-border p-2.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="text-sm">
                    <span className="font-semibold">Level {sh.level}</span>
                    <span className="text-muted-foreground"> · {sh.height_cm} cm · </span>
                    <span className="font-mono text-xs">{sh.code}</span>
                  </div>
                  <span className={cn("tabular text-xs", used >= sh.capacity_facings ? "text-danger" : "text-muted-foreground")}>
                    {used}/{sh.capacity_facings} facings
                  </span>
                </div>
                {sh.is_clearance && <Badge variant="danger" className="mt-1">Clearance</Badge>}
                {sh.products.length ? (
                  <ul className="mt-2 flex flex-col gap-1">
                    {sh.products.map((p) => (
                      <li key={p.placement_id} className="flex items-center justify-between gap-2 text-sm">
                        <span className="min-w-0">
                          <span className="block truncate">{p.name}</span>
                          <span className="text-xs text-muted-foreground">
                            {p.sku} · {p.facings} facing{p.facings === 1 ? "" : "s"}
                            {p.is_primary ? " · primary" : " · secondary"}
                          </span>
                        </span>
                        {editable && (
                          <span className="flex shrink-0 gap-1">
                            <Button variant="ghost" size="icon" aria-label={`Move ${p.name}`} onClick={() => onStartMove(p, sh)}>
                              <Move />
                            </Button>
                            <Button variant="ghost" size="icon" aria-label={`Remove ${p.name} from ${sh.code}`} disabled={busy} onClick={() => onRemove(p.placement_id)}>
                              <Trash2 />
                            </Button>
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-1 text-xs text-muted-foreground">Empty</p>
                )}
                {editable && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="mt-2 w-full"
                    disabled={!selectedProduct || busy}
                    onClick={() => onPlace(sh)}
                    aria-label={selectedProduct ? `Place ${selectedProduct.name} on ${sh.code}` : `Place here (${sh.code})`}
                  >
                    <ArrowRightLeft /> {selectedProduct ? "Place here" : "Select a product to place"}
                  </Button>
                )}
              </li>
            );
          })}
        </ol>
      </CardContent>
    </Card>
  );
}

function DropDialog({ target, productName, layout, busy, onClose, onPlace }: {
  target: { section: ShelfSection; productId: string } | null;
  productName?: string;
  layout: Layout | null;
  busy: boolean;
  onClose: () => void;
  onPlace: (shelfCode: string, opts: { facings: number; from?: string }) => void;
}) {
  const [facings, setFacings] = React.useState(1);
  const [from, setFrom] = React.useState("");
  const [level, setLevel] = React.useState<string>("");
  React.useEffect(() => {
    if (target) {
      setFacings(1);
      setFrom("");
      setLevel(target.section.shelves[0]?.code ?? "");
    }
  }, [target]);
  const current = layout && target ? layout.shelves.filter((s) => s.products.some((p) => p.product_id === target.productId)) : [];
  return (
    <Dialog open={!!target} onOpenChange={(o) => !o && onClose()}>
      <DialogContent title={`Place on section ${target?.section.label ?? ""}`} description={productName ? `Product: ${productName}` : undefined} size="sm">
        {target && (
          <div className="flex flex-col gap-3">
            <fieldset className="flex flex-col gap-1.5">
              <legend className="mb-1 text-sm font-medium">Level</legend>
              {target.section.shelves.map((s) => (
                <label key={s.id} className="flex items-center gap-2 rounded-md border border-border px-2 py-1.5 text-sm has-[:checked]:border-primary has-[:checked]:bg-primary-soft">
                  <input type="radio" name="drop-level" value={s.code} checked={level === s.code} onChange={() => setLevel(s.code)} />
                  Level {s.level} · {s.height_cm} cm <span className="font-mono text-xs text-muted-foreground">{s.code}</span>
                  <span className="ml-auto text-xs text-muted-foreground">{s.products.reduce((n, p) => n + p.facings, 0)}/{s.capacity_facings}</span>
                </label>
              ))}
            </fieldset>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Facings" htmlFor="drop-facings">
                <Input id="drop-facings" type="number" min={1} max={12} value={facings} onChange={(e) => setFacings(Math.min(12, Math.max(1, Number(e.target.value) || 1)))} />
              </Field>
              <Field label="Mode" htmlFor="drop-from">
                <Select id="drop-from" value={from} onChange={(e) => setFrom(e.target.value)}>
                  <option value="">Add placement</option>
                  {current.map((s) => (
                    <option key={s.id} value={s.code}>
                      Move from {s.code}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => level && onPlace(level, { facings, from })} loading={busy} disabled={!level}>
            Place product
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DiffDialog({ open, onOpenChange, diff, loading, error }: { open: boolean; onOpenChange: (o: boolean) => void; diff?: LayoutDiff; loading: boolean; error: unknown }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Draft vs active layout" description="Products whose shelf locations differ between the active layout and this draft." size="lg">
        {error ? (
          <ErrorState error={error} />
        ) : loading || !diff ? (
          <Skeleton className="h-40 w-full" />
        ) : !diff.changes.length ? (
          <EmptyState title="No placement changes yet" description="Fixture moves are not listed here; only product placements are compared." />
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>Product</TH>
                <TH>Active (current)</TH>
                <TH>Draft (proposed)</TH>
              </TR>
            </THead>
            <TBody>
              {diff.changes.map((c) => {
                const added = c.proposed.filter((x) => !c.current.includes(x));
                const removed = c.current.filter((x) => !c.proposed.includes(x));
                return (
                  <TR key={c.product_id}>
                    <TD className="font-medium">{c.name ?? c.product_id}</TD>
                    <TD>
                      <CodeList codes={c.current} marked={removed} tone="danger" empty="Not placed" />
                    </TD>
                    <TD>
                      <CodeList codes={c.proposed} marked={added} tone="success" empty="Removed" />
                    </TD>
                  </TR>
                );
              })}
            </TBody>
          </Table>
        )}
      </DialogContent>
    </Dialog>
  );
}

function CodeList({ codes, marked, tone, empty }: { codes: string[]; marked: string[]; tone: "danger" | "success"; empty: string }) {
  if (!codes.length) return <span className="text-xs text-muted-foreground">{empty}</span>;
  return (
    <span className="flex flex-wrap gap-1">
      {codes.map((c) => (
        <Badge key={c} variant={marked.includes(c) ? tone : "neutral"} className="font-mono">
          {c}
        </Badge>
      ))}
    </span>
  );
}
