import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell } from "lucide-react";
import { useNavigate } from "react-router-dom";

import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/menu";
import { api } from "@/lib/api";
import { cn, timeAgo } from "@/lib/utils";
import type { NotificationItem } from "@/types/api";

export const NOTIFICATIONS_KEY = ["notifications"] as const;

export function NotificationBell({ allLink }: { allLink: string }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const q = useQuery({
    queryKey: NOTIFICATIONS_KEY,
    queryFn: () => api.get<{ unread: number; items: NotificationItem[] }>("/notifications", { limit: 8 }),
    refetchInterval: 30_000,
  });
  const read = useMutation({
    mutationFn: (id: string) => api.post(`/notifications/${id}/read`),
    onSuccess: () => qc.invalidateQueries({ queryKey: NOTIFICATIONS_KEY }),
  });
  const unread = q.data?.unread ?? 0;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={`Notifications${unread ? `, ${unread} unread` : ""}`} className="relative">
          <Bell />
          {unread > 0 && (
            <span className="absolute -right-0.5 -top-0.5 flex min-w-4 items-center justify-center rounded-full bg-danger px-1 text-[10px] font-semibold text-white">
              {unread > 9 ? "9+" : unread}
            </span>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-80">
        <DropdownMenuLabel>Notifications</DropdownMenuLabel>
        {q.data?.items.length ? (
          q.data.items.map((n) => (
            <DropdownMenuItem
              key={n.id}
              className="items-start"
              onSelect={() => {
                if (!n.read) read.mutate(n.id);
                if (n.link) navigate(n.link);
              }}
            >
              <span className={cn("mt-1.5 size-2 shrink-0 rounded-full", n.read ? "bg-transparent" : "bg-primary")} aria-hidden />
              <span className="min-w-0">
                <span className="block truncate font-medium">{n.title}</span>
                <span className="line-clamp-2 text-xs text-muted-foreground">{n.body}</span>
                <span className="text-[11px] text-muted-foreground">{timeAgo(n.created_at)}</span>
              </span>
            </DropdownMenuItem>
          ))
        ) : (
          <p className="px-2 py-4 text-center text-sm text-muted-foreground">{q.isLoading ? "Loading…" : "You're all caught up."}</p>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => navigate(allLink)} className="justify-center text-primary">
          View all notifications
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
