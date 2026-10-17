import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, CalendarClock, Link2Off, ListChecks, UserRound } from "lucide-react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { KeyValue } from "@/components/ui/data";
import { EmptyState, ErrorState, Skeleton } from "@/components/ui/feedback";
import { api, ApiError, errorMessage } from "@/lib/api";
import { formatDateTime } from "@/lib/utils";
import type { ShoppingListView } from "@/types/api";
import type { InvitationPreview } from "@/features/shopping-lists/types";

const INVITE_ERRORS: Record<string, { title: string; description: string }> = {
  invitation_expired: { title: "This invitation has expired", description: "Ask the list owner to send you a new link." },
  invitation_revoked: { title: "This invitation was revoked", description: "The list owner has turned this link off. Ask them for a new one." },
  invitation_exhausted: { title: "This invitation has been used up", description: "It has reached its maximum number of uses. Ask the list owner for a new link." },
  not_found: { title: "Invitation not found", description: "The link may be mistyped or incomplete. Check it and try again." },
};

export function inviteErrorInfo(err: unknown): { title: string; description: string } | null {
  if (!(err instanceof ApiError)) return null;
  return INVITE_ERRORS[err.code] ?? (err.status === 404 ? INVITE_ERRORS.not_found : null);
}

export default function InviteAcceptPage() {
  const { token = "" } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const preview = useQuery({
    queryKey: ["invitation", token],
    queryFn: () => api.get<InvitationPreview>(`/invitations/${encodeURIComponent(token)}`),
    retry: false,
  });
  const accept = useMutation({
    mutationFn: () => api.post<ShoppingListView>(`/invitations/${encodeURIComponent(token)}/accept`),
    onSuccess: (list) => {
      void qc.invalidateQueries({ queryKey: ["shopping-lists"] });
      toast.success(`You joined “${list.name}”`);
      navigate(`/shop/lists/${list.id}`, { replace: true });
    },
    onError: (e) => {
      if (!inviteErrorInfo(e)) toast.error(errorMessage(e));
    },
  });

  const failure = inviteErrorInfo(preview.error) ?? inviteErrorInfo(accept.error);

  return (
    <div className="flex min-h-full flex-col items-center justify-center bg-background px-4 py-10">
      <Link to="/shop" className="mb-6 flex items-center gap-2 font-semibold text-primary">
        <Activity className="size-5" aria-hidden /> OmniPulse
      </Link>
      <div className="w-full max-w-md">
        {preview.isLoading ? (
          <Card className="space-y-3 p-6" aria-busy="true">
            <Skeleton className="h-6 w-2/3" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-10 w-full" />
          </Card>
        ) : failure ? (
          <EmptyState
            icon={Link2Off}
            title={failure.title}
            description={failure.description}
            className="bg-surface"
            action={
              <Button asChild variant="outline">
                <Link to="/shop/lists">Go to my lists</Link>
              </Button>
            }
          />
        ) : preview.isError ? (
          <ErrorState error={preview.error} onRetry={() => preview.refetch()} />
        ) : preview.data ? (
          <Card>
            <CardHeader>
              <p className="text-xs font-medium uppercase tracking-wide text-primary">Shared shopping list</p>
              <CardTitle className="text-xl">
                {preview.data.owner_name} invited you to “{preview.data.list_name}”
              </CardTitle>
            </CardHeader>
            <CardContent>
              <KeyValue
                items={[
                  [
                    "Owner",
                    <span className="inline-flex items-center gap-1">
                      <UserRound className="size-3.5" aria-hidden /> {preview.data.owner_name}
                    </span>,
                  ],
                  ["Your access", preview.data.role === "editor" ? "Can add, edit and check off items" : "View only"],
                  [
                    "Items",
                    <span className="inline-flex items-center gap-1">
                      <ListChecks className="size-3.5" aria-hidden /> {preview.data.item_count}
                    </span>,
                  ],
                  [
                    "Link expires",
                    <span className="inline-flex items-center gap-1">
                      <CalendarClock className="size-3.5" aria-hidden /> {formatDateTime(preview.data.expires_at)}
                    </span>,
                  ],
                ]}
              />
            </CardContent>
            <CardFooter className="justify-end">
              <Button asChild variant="ghost">
                <Link to="/shop">Not now</Link>
              </Button>
              <Button onClick={() => accept.mutate()} loading={accept.isPending}>
                Join list
              </Button>
            </CardFooter>
          </Card>
        ) : null}
      </div>
    </div>
  );
}
