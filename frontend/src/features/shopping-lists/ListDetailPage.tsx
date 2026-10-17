import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Eye, ListX, Plus, Users } from "lucide-react";
import * as React from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";

import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Callout, EmptyState, ErrorState, Progress, Skeleton } from "@/components/ui/feedback";
import { Input } from "@/components/ui/input";
import { Tooltip } from "@/components/ui/menu";
import { useAuth } from "@/features/auth/auth-context";
import { MY_LISTS_KEY } from "@/features/shopping-assistant/components/AddToListButton";
import { api, ApiError, errorMessage } from "@/lib/api";
import type { SocketStatus } from "@/lib/list-socket";
import { cn, formatCurrency, timeAgo } from "@/lib/utils";
import type { ListItem, ShoppingListView } from "@/types/api";
import { effectivePrice } from "@/features/shopping-assistant/components/product-meta";

import { ChangeMatchDialog } from "./components/ChangeMatchDialog";
import { ListItemRow } from "./components/ListItemRow";
import { RoutePanel } from "./components/RoutePanel";
import { ShareDialog } from "./components/ShareDialog";
import { computeGroups, computeProgress, upsertItem } from "./list-events";
import type { OperationResult } from "./types";
import { listKey, useLiveList } from "./use-live-list";

export default function ListDetailPage() {
  const { listId = "" } = useParams();
  return <ListDetail key={listId} listId={listId} />;
}

function ListDetail({ listId }: { listId: string }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { me } = useAuth();
  const live = useLiveList(listId);
  const { list, items, status, online, sendOp, pendingChanges } = live;
  const [matching, setMatching] = React.useState<ListItem | null>(null);
  const [draft, setDraft] = React.useState("");

  React.useEffect(() => {
    if (live.deleted) {
      toast.info("This list was deleted by its owner.");
      void qc.invalidateQueries({ queryKey: MY_LISTS_KEY });
      navigate("/shop/lists", { replace: true });
    }
  }, [live.deleted, navigate, qc]);

  const applyResult = (res: OperationResult) => {
    const item = res.item;
    if (item) qc.setQueryData<ShoppingListView>(listKey(listId), (old) => (old ? upsertItem(old, item) : old));
    void qc.invalidateQueries({ queryKey: listKey(listId), exact: true });
    void qc.invalidateQueries({ queryKey: MY_LISTS_KEY });
  };

  const addItem = useMutation({
    mutationFn: (text: string) => api.post<OperationResult>(`/shopping-lists/${listId}/items`, { raw_text: text, quantity: 1 }),
    onSuccess: (res) => {
      setDraft("");
      applyResult(res);
      const merged = (res.event.payload as { merged_duplicate?: boolean }).merged_duplicate;
      if (merged) toast.info(`Already on the list — increased the quantity of ${res.item?.display_name ?? "that item"}.`);
      else if (res.item?.status === "unresolved") toast.warning(`No product found for “${res.item.raw_text}”. Kept it as unresolved.`);
      else toast.success(`Added ${res.item?.display_name ?? "item"}`);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const changeProduct = useMutation({
    mutationFn: (vars: { item: ListItem; productId: string }) =>
      api.patch<OperationResult>(`/shopping-lists/${listId}/items/${vars.item.id}`, { product_id: vars.productId, expected_version: vars.item.version }),
    onSuccess: (res) => {
      applyResult(res);
      setMatching(null);
      toast.success(`Matched to ${res.item?.display_name ?? "the selected product"}`);
    },
    onError: (e) => {
      toast.error(e instanceof ApiError && e.status === 409 ? "Someone else just changed this item. We refreshed it — try again." : errorMessage(e));
      void qc.invalidateQueries({ queryKey: listKey(listId), exact: true });
    },
  });

  if (live.accessError) {
    return (
      <EmptyState
        icon={ListX}
        title="You can't open this list"
        description={live.accessError}
        action={
          <Button asChild variant="outline">
            <Link to="/shop/lists">Back to my lists</Link>
          </Button>
        }
      />
    );
  }
  if (live.query.isLoading) return <DetailSkeleton />;
  if (live.query.isError || !list) {
    const notFound = live.query.error instanceof ApiError && [403, 404].includes(live.query.error.status);
    return notFound ? (
      <EmptyState
        icon={ListX}
        title="List not found"
        description="It may have been deleted, or you're no longer a member."
        action={
          <Button asChild variant="outline">
            <Link to="/shop/lists">Back to my lists</Link>
          </Button>
        }
      />
    ) : (
      <ErrorState error={live.query.error} onRetry={() => live.query.refetch()} />
    );
  }

  const canEdit = list.my_role === "owner" || list.my_role === "editor";
  const groups = computeGroups(items);
  const progress = computeProgress(items);
  const memberName = (id: string | null) => (id ? list.members.find((m) => m.user_id === id)?.name ?? null : null);
  const estimate = items.reduce((sum, i) => sum + (i.product ? effectivePrice(i.product) * i.quantity : 0), 0);

  const toggle = (item: ListItem) => {
    const collect = item.status !== "collected";
    sendOp(
      collect ? { op: "collect", item_id: item.id } : { op: "uncollect", item_id: item.id },
      { status: collect ? "collected" : "pending" },
    );
  };

  return (
    <div className="space-y-6">
      <div>
        <Button asChild variant="ghost" size="sm" className="-ml-2 mb-2">
          <Link to="/shop/lists">
            <ArrowLeft aria-hidden /> My lists
          </Link>
        </Button>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-2xl font-semibold">{list.name}</h1>
              {list.status !== "active" && <StatusBadge status={list.status} />}
              {list.is_shared && <Badge variant="info">Shared</Badge>}
              {list.my_role === "viewer" && (
                <Badge variant="neutral">
                  <Eye className="size-3" aria-hidden /> View only
                </Badge>
              )}
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              {list.store?.name ?? "No store"} · updated {timeAgo(list.updated_at)}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <ConnectionBadge status={status} pending={pendingChanges} />
            <OnlineMembers online={online} myId={me?.user.id} />
            {list.my_role === "owner" && <ShareDialog list={list} myUserId={me?.user.id} />}
          </div>
        </div>
      </div>

      {list.my_role === "viewer" && (
        <Callout title="You have view-only access">You'll see changes live as others shop, but you can't edit this list.</Callout>
      )}
      {status === "reconnecting" && pendingChanges > 0 && (
        <Callout tone="warning" title="Reconnecting">
          {pendingChanges} change{pendingChanges === 1 ? "" : "s"} will sync automatically when the connection is back.
        </Callout>
      )}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="space-y-4">
          <Card className="p-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
              <span>
                <span className="tabular font-semibold">{progress.collected}</span> of {progress.total} collected
                {progress.unresolved > 0 && <span className="text-danger"> · {progress.unresolved} need a match</span>}
                {progress.unavailable > 0 && <span className="text-warning"> · {progress.unavailable} out of stock</span>}
              </span>
              {estimate > 0 && <span className="tabular text-muted-foreground">Est. {formatCurrency(estimate)}</span>}
            </div>
            <Progress value={progress.percent} className="mt-2" label="List progress" />
          </Card>

          {canEdit && (
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (draft.trim()) addItem.mutate(draft.trim());
              }}
            >
              <Input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Add an item, e.g. 2 kg rice" aria-label="Add an item" maxLength={160} />
              <Button type="submit" loading={addItem.isPending} disabled={!draft.trim()}>
                <Plus aria-hidden /> Add
              </Button>
            </form>
          )}

          {items.length === 0 ? (
            <EmptyState title="This list is empty" description={canEdit ? "Add your first item above." : "Nothing has been added yet."} />
          ) : (
            groups.map((g) => (
              <section key={g.key} aria-labelledby={`grp-${g.key}`} className="overflow-hidden rounded-lg border border-border bg-surface shadow-[var(--shadow-card)]">
                <h2 id={`grp-${g.key}`} className={cn("flex items-center justify-between border-b border-border bg-surface-raised px-4 py-2 text-sm font-semibold", g.key === "unresolved" && "text-danger")}>
                  {g.label}
                  <span className="text-xs font-normal text-muted-foreground">
                    {g.items.filter((i) => i.status === "collected").length}/{g.items.length}
                  </span>
                </h2>
                <ul className="divide-y divide-border">
                  {g.items.map((it) => (
                    <ListItemRow
                      key={it.id}
                      item={it}
                      canEdit={canEdit}
                      collectedByName={memberName(it.collected_by_id)}
                      onToggle={() => toggle(it)}
                      onQuantity={(quantity) => sendOp({ op: "update_item", item_id: it.id, quantity }, { quantity })}
                      onRemove={() => sendOp({ op: "remove_item", item_id: it.id }, { removed: true })}
                      onChangeMatch={() => setMatching(it)}
                    />
                  ))}
                </ul>
              </section>
            ))
          )}
        </div>

        <div className="lg:sticky lg:top-20 lg:self-start">
          <RoutePanel listId={list.id} storeId={list.store?.id ?? null} items={items} />
        </div>
      </div>

      <ChangeMatchDialog
        item={matching}
        storeId={list.store?.id ?? null}
        saving={changeProduct.isPending}
        onClose={() => setMatching(null)}
        onSelect={(productId) => matching && changeProduct.mutate({ item: matching, productId })}
      />
    </div>
  );
}

const STATUS_META: Record<SocketStatus, { label: string; dot: string; hint: string }> = {
  open: { label: "Live", dot: "bg-success", hint: "Changes from other members appear instantly." },
  connecting: { label: "Connecting…", dot: "bg-warning", hint: "Connecting to live updates." },
  reconnecting: { label: "Reconnecting…", dot: "bg-warning animate-pulse", hint: "Connection lost. Your changes are queued and will sync." },
  closed: { label: "Offline", dot: "bg-muted-foreground", hint: "Live updates are off. Refresh to reconnect." },
};

function ConnectionBadge({ status, pending }: { status: SocketStatus; pending: number }) {
  const m = STATUS_META[status];
  return (
    <Tooltip content={m.hint}>
      <span tabIndex={0} role="status" className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-2.5 py-1 text-xs font-medium">
        <span className={cn("size-2 rounded-full", m.dot)} aria-hidden />
        {m.label}
        {pending > 0 && <span className="text-muted-foreground">· {pending} syncing</span>}
      </span>
    </Tooltip>
  );
}

function OnlineMembers({ online, myId }: { online: { user_id: string; name: string }[]; myId?: string }) {
  const unique = [...new Map(online.map((m) => [m.user_id, m])).values()];
  if (!unique.length) return null;
  const others = unique.filter((m) => m.user_id !== myId);
  return (
    <Tooltip content={`Online now: ${unique.map((m) => (m.user_id === myId ? `${m.name} (you)` : m.name)).join(", ")}`}>
      <span tabIndex={0} className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-2.5 py-1 text-xs">
        <Users className="size-3.5 text-muted-foreground" aria-hidden />
        <span className="flex -space-x-1.5" aria-hidden>
          {unique.slice(0, 4).map((m) => (
            <span key={m.user_id} className="flex size-5 items-center justify-center rounded-full border-2 border-surface bg-primary-soft text-[10px] font-semibold text-primary">
              {m.name.charAt(0)}
            </span>
          ))}
        </span>
        <span>{others.length ? `${others.length} other${others.length === 1 ? "" : "s"} online` : "Only you online"}</span>
      </span>
    </Tooltip>
  );
}

function DetailSkeleton() {
  return (
    <div className="space-y-4" aria-busy="true" aria-label="Loading list">
      <Skeleton className="h-8 w-64" />
      <Skeleton className="h-4 w-40" />
      <div className="grid gap-6 lg:grid-cols-[3fr_2fr]">
        <div className="space-y-3">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-48 w-full" />
        </div>
        <Skeleton className="h-72 w-full" />
      </div>
    </div>
  );
}
