import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BellOff, CheckCheck, ChevronRight, Gift, ListChecks, MapPin, Package, Users, type LucideIcon } from "lucide-react";
import * as React from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/data";
import { EmptyState, ErrorState, SkeletonRows } from "@/components/ui/feedback";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api, errorMessage } from "@/lib/api";
import { cn, formatDateTime, timeAgo, titleCase } from "@/lib/utils";
import type { NotificationItem } from "@/types/api";

const KEY = ["notifications", "page"] as const;

const TYPE_ICON: Record<string, LucideIcon> = {
  nearby_offer: MapPin,
  offer: Gift,
  shopping_reminder: ListChecks,
  shared_list: Users,
  stock: Package,
};

export default function NotificationsPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [filter, setFilter] = React.useState<"all" | "unread">("all");
  const q = useQuery({
    queryKey: KEY,
    queryFn: () => api.get<{ unread: number; items: NotificationItem[] }>("/notifications", { limit: 100 }),
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ["notifications"] });
  const markRead = useMutation({
    mutationFn: (id: string) => api.post(`/notifications/${id}/read`),
    onMutate: (id) => {
      qc.setQueryData<{ unread: number; items: NotificationItem[] }>(KEY, (old) =>
        old ? { unread: Math.max(0, old.unread - (old.items.find((n) => n.id === id && !n.read) ? 1 : 0)), items: old.items.map((n) => (n.id === id ? { ...n, read: true } : n)) } : old,
      );
    },
    onError: (e) => toast.error(errorMessage(e)),
    onSettled: invalidate,
  });
  const markAll = useMutation({
    mutationFn: () => api.post<{ updated: number }>("/notifications/read-all"),
    onSuccess: (r) => toast.success(r.updated ? `Marked ${r.updated} as read` : "Everything was already read"),
    onError: (e) => toast.error(errorMessage(e)),
    onSettled: invalidate,
  });

  const items = (q.data?.items ?? []).filter((n) => filter === "all" || !n.read);
  const unread = q.data?.unread ?? 0;

  const open = (n: NotificationItem) => {
    if (!n.read) markRead.mutate(n.id);
    if (n.link) navigate(n.link);
  };

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title="Notifications"
        description={unread ? `${unread} unread` : "You're all caught up."}
        actions={
          <Button variant="outline" onClick={() => markAll.mutate()} loading={markAll.isPending} disabled={!unread}>
            <CheckCheck aria-hidden /> Mark all as read
          </Button>
        }
      />
      <Tabs value={filter} onValueChange={(v) => setFilter(v as "all" | "unread")} className="mb-4">
        <TabsList aria-label="Filter notifications">
          <TabsTrigger value="all">All</TabsTrigger>
          <TabsTrigger value="unread">Unread{unread ? ` (${unread})` : ""}</TabsTrigger>
        </TabsList>
      </Tabs>
      {q.isLoading ? (
        <SkeletonRows rows={6} />
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : !items.length ? (
        <EmptyState
          icon={BellOff}
          title={filter === "unread" ? "No unread notifications" : "No notifications yet"}
          description="Offers, list activity and reminders will show up here."
        />
      ) : (
        <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-surface shadow-[var(--shadow-card)]">
          {items.map((n) => {
            const Icon = TYPE_ICON[n.type] ?? Gift;
            return (
              <li key={n.id} className={cn("flex items-start gap-3 px-4 py-3", !n.read && "bg-primary-soft/50")}>
                <span className={cn("mt-0.5 rounded-md p-2", n.read ? "bg-muted text-muted-foreground" : "bg-primary-soft text-primary")}>
                  <Icon className="size-4" aria-hidden />
                </span>
                <button type="button" onClick={() => open(n)} className="min-w-0 flex-1 text-left" disabled={!n.link && n.read}>
                  <span className="flex flex-wrap items-center gap-2">
                    <span className={cn("text-sm", !n.read ? "font-semibold" : "font-medium")}>{n.title}</span>
                    {!n.read && <span className="sr-only">(unread)</span>}
                    <Badge variant="neutral">{titleCase(n.type)}</Badge>
                  </span>
                  <span className="mt-0.5 block text-sm text-foreground/80">{n.body}</span>
                  <span className="mt-1 block text-xs text-muted-foreground" title={formatDateTime(n.created_at)}>
                    {timeAgo(n.created_at)} · {n.channel.replace(/_/g, " ")}
                  </span>
                </button>
                <div className="flex shrink-0 items-center gap-1">
                  {!n.read && (
                    <Button size="sm" variant="ghost" onClick={() => markRead.mutate(n.id)} aria-label={`Mark “${n.title}” as read`}>
                      Mark read
                    </Button>
                  )}
                  {n.link && <ChevronRight className="size-4 text-muted-foreground" aria-hidden />}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
