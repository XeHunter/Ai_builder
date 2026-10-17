import { ListChecks, Plus, Store, Users } from "lucide-react";
import * as React from "react";
import { Link, useSearchParams } from "react-router-dom";

import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/data";
import { EmptyState, ErrorState, Progress, Skeleton } from "@/components/ui/feedback";
import { timeAgo } from "@/lib/utils";
import type { ListSummary } from "@/types/api";
import { useMyLists } from "@/features/shopping-assistant/components/AddToListButton";

import { NewListDialog } from "./components/NewListDialog";

export default function ListsPage() {
  const [params, setParams] = useSearchParams();
  const [open, setOpen] = React.useState(params.get("new") === "1");
  const lists = useMyLists();

  const onOpenChange = (o: boolean) => {
    setOpen(o);
    if (!o && params.has("new")) {
      const next = new URLSearchParams(params);
      next.delete("new");
      setParams(next, { replace: true });
    }
  };

  const sorted = React.useMemo(
    () => [...(lists.data ?? [])].sort((a, b) => (a.status === "archived" ? 1 : 0) - (b.status === "archived" ? 1 : 0) || b.updated_at.localeCompare(a.updated_at)),
    [lists.data],
  );

  return (
    <div>
      <PageHeader
        title="Shopping lists"
        description="Smart lists matched to the store catalog, shared in real time with the people you shop with."
        actions={
          <Button onClick={() => onOpenChange(true)}>
            <Plus aria-hidden /> New smart list
          </Button>
        }
      />
      {lists.isLoading ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-36 w-full" />
          ))}
        </div>
      ) : lists.isError ? (
        <ErrorState error={lists.error} onRetry={() => lists.refetch()} />
      ) : !sorted.length ? (
        <EmptyState
          icon={ListChecks}
          title="No lists yet"
          description="Type what you need in plain words — we'll match every item to a product on the shelf and plan your route."
          action={
            <Button onClick={() => onOpenChange(true)}>
              <Plus aria-hidden /> Create your first list
            </Button>
          }
        />
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {sorted.map((l) => (
            <li key={l.id}>
              <ListCard list={l} />
            </li>
          ))}
        </ul>
      )}
      <NewListDialog open={open} onOpenChange={onOpenChange} />
    </div>
  );
}

function ListCard({ list }: { list: ListSummary }) {
  const pct = list.item_count ? Math.round((list.collected_count / list.item_count) * 100) : 0;
  return (
    <Link
      to={`/shop/lists/${list.id}`}
      className="flex h-full flex-col gap-3 rounded-lg border border-border bg-surface p-4 shadow-[var(--shadow-card)] transition hover:border-primary/40"
    >
      <div className="flex items-start justify-between gap-2">
        <span className="font-medium">{list.name}</span>
        {list.status !== "active" && <StatusBadge status={list.status} />}
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          <Store className="size-3.5" aria-hidden /> {list.store_name ?? "No store"}
        </span>
        {list.is_shared && (
          <Badge variant="info">
            <Users className="size-3" aria-hidden /> Shared
          </Badge>
        )}
        <Badge variant={list.my_role === "owner" ? "primary" : "neutral"}>{list.my_role === "owner" ? "Owner" : list.my_role === "editor" ? "Editor" : "Viewer"}</Badge>
      </div>
      <div className="mt-auto space-y-1.5">
        <div className="flex justify-between text-xs">
          <span className="tabular">
            {list.collected_count}/{list.item_count} collected
          </span>
          <span className="text-muted-foreground">Updated {timeAgo(list.updated_at)}</span>
        </div>
        <Progress value={pct} label={`${list.name} progress`} />
      </div>
    </Link>
  );
}
