/** Owner-only sharing: create expiring invitations (link + QR), revoke them, and manage members. */
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Link2, Share2, UserMinus } from "lucide-react";
import * as React from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";

import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/dialog";
import { SkeletonRows } from "@/components/ui/feedback";
import { Field, Input, Select } from "@/components/ui/input";
import { api, errorMessage } from "@/lib/api";
import { formatDateTime } from "@/lib/utils";
import type { InvitationCreated, ShoppingListView } from "@/types/api";

import type { InvitationOut } from "../types";
import { listKey } from "../use-live-list";

const schema = z.object({
  role: z.enum(["editor", "viewer"]),
  ttl_hours: z.number({ error: "Enter a number of hours" }).int("Whole hours only").min(1, "At least 1 hour").max(336, "At most 14 days (336 hours)"),
  max_uses: z.number({ error: "Enter a number" }).int("Whole numbers only").min(1, "At least 1").max(50, "At most 50"),
});
type FormValues = z.infer<typeof schema>;

export function svgDataUri(svg: string): string {
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through */
  }
  return false;
}

export function ShareDialog({ list, myUserId }: { list: ShoppingListView; myUserId: string | undefined }) {
  const qc = useQueryClient();
  const [open, setOpen] = React.useState(false);
  const [created, setCreated] = React.useState<InvitationCreated | null>(null);
  const linkRef = React.useRef<HTMLInputElement>(null);
  const invKey = ["list-invitations", list.id];

  const invitations = useQuery({
    queryKey: invKey,
    queryFn: () => api.get<InvitationOut[]>(`/shopping-lists/${list.id}/invitations`),
    enabled: open,
  });

  const form = useForm<FormValues>({ resolver: zodResolver(schema), defaultValues: { role: "editor", ttl_hours: 72, max_uses: 5 } });

  const create = useMutation({
    mutationFn: (v: FormValues) => api.post<InvitationCreated>(`/shopping-lists/${list.id}/invitations`, v),
    onSuccess: (inv) => {
      setCreated(inv);
      toast.success("Invitation link created");
      void qc.invalidateQueries({ queryKey: invKey });
      void qc.invalidateQueries({ queryKey: listKey(list.id) });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const revoke = useMutation({
    mutationFn: (id: string) => api.delete<InvitationOut>(`/shopping-lists/${list.id}/invitations/${id}`),
    onSuccess: (inv) => {
      toast.success("Invitation revoked");
      if (created?.id === inv.id) setCreated(null);
      void qc.invalidateQueries({ queryKey: invKey });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const removeMember = useMutation({
    mutationFn: (userId: string) => api.delete(`/shopping-lists/${list.id}/members/${userId}`),
    onSuccess: () => {
      toast.success("Member removed");
      void qc.invalidateQueries({ queryKey: listKey(list.id) });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const onCopy = async () => {
    if (!created) return;
    if (await copyText(created.url)) toast.success("Link copied");
    else {
      linkRef.current?.select();
      toast.info("Copying isn't available here — the link is selected, copy it manually.");
    }
  };

  const errors = form.formState.errors;
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setCreated(null);
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline">
          <Share2 aria-hidden /> Share
        </Button>
      </DialogTrigger>
      <DialogContent title={`Share “${list.name}”`} description="Invite family or friends to shop this list with you in real time." size="lg">
        <div className="space-y-6">
          <form onSubmit={form.handleSubmit((v) => create.mutate(v))} className="grid gap-3 sm:grid-cols-3" noValidate>
            <Field label="Access" htmlFor="inv-role">
              <Select id="inv-role" {...form.register("role")}>
                <option value="editor">Can edit</option>
                <option value="viewer">View only</option>
              </Select>
            </Field>
            <Field label="Expires after (hours)" htmlFor="inv-ttl" error={errors.ttl_hours?.message}>
              <Input id="inv-ttl" type="number" min={1} max={336} aria-invalid={!!errors.ttl_hours} {...form.register("ttl_hours", { valueAsNumber: true })} />
            </Field>
            <Field label="Max uses" htmlFor="inv-uses" error={errors.max_uses?.message}>
              <Input id="inv-uses" type="number" min={1} max={50} aria-invalid={!!errors.max_uses} {...form.register("max_uses", { valueAsNumber: true })} />
            </Field>
            <div className="sm:col-span-3">
              <Button type="submit" loading={create.isPending}>
                <Link2 aria-hidden /> Create invitation link
              </Button>
            </div>
          </form>

          {created && (
            <div className="flex flex-col gap-4 rounded-lg border border-primary/30 bg-primary-soft p-4 sm:flex-row">
              <img src={svgDataUri(created.qr_svg)} alt="QR code for the invitation link" className="size-40 shrink-0 self-center rounded-md bg-white p-2" />
              <div className="min-w-0 flex-1 space-y-2">
                <p className="text-sm font-medium">Scan the QR code or send this link</p>
                <div className="flex gap-2">
                  <Input ref={linkRef} readOnly value={created.url} aria-label="Invitation link" onFocus={(e) => e.currentTarget.select()} />
                  <Button type="button" variant="outline" onClick={onCopy} aria-label="Copy invitation link">
                    <Copy aria-hidden /> Copy
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  {created.role === "editor" ? "Can edit" : "View only"} · up to {created.max_uses} people · expires {formatDateTime(created.expires_at)}.
                  This link is shown only once.
                </p>
              </div>
            </div>
          )}

          <section aria-labelledby="members-title">
            <h3 id="members-title" className="mb-2 text-sm font-semibold">
              Members
            </h3>
            <ul className="divide-y divide-border rounded-md border border-border">
              {list.members.map((m) => (
                <li key={m.user_id} className="flex items-center gap-3 px-3 py-2 text-sm">
                  <span className="flex-1">
                    {m.name}
                    {m.user_id === myUserId && <span className="text-muted-foreground"> (you)</span>}
                  </span>
                  <Badge variant={m.role === "owner" ? "primary" : "neutral"}>{m.role}</Badge>
                  {m.role !== "owner" && (
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label={`Remove ${m.name}`}
                      disabled={removeMember.isPending}
                      onClick={() => removeMember.mutate(m.user_id)}
                    >
                      <UserMinus />
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          </section>

          <section aria-labelledby="invites-title">
            <h3 id="invites-title" className="mb-2 text-sm font-semibold">
              Invitation links
            </h3>
            {invitations.isLoading ? (
              <SkeletonRows rows={2} />
            ) : invitations.isError ? (
              <p className="text-sm text-danger">{errorMessage(invitations.error)}</p>
            ) : !invitations.data?.length ? (
              <p className="text-sm text-muted-foreground">No invitations yet.</p>
            ) : (
              <ul className="divide-y divide-border rounded-md border border-border">
                {invitations.data.map((inv) => {
                  const expired = new Date(inv.expires_at).getTime() <= Date.now();
                  const state = inv.revoked ? "revoked" : expired ? "expired" : inv.use_count >= inv.max_uses ? "used_up" : "active";
                  return (
                    <li key={inv.id} className="flex flex-wrap items-center gap-3 px-3 py-2 text-sm">
                      <span className="flex-1">
                        {inv.role === "editor" ? "Can edit" : "View only"} · {inv.use_count}/{inv.max_uses} used
                        <span className="block text-xs text-muted-foreground">Expires {formatDateTime(inv.expires_at)}</span>
                      </span>
                      <StatusBadge status={state} />
                      {state === "active" && (
                        <Button size="sm" variant="ghost" className="text-danger" loading={revoke.isPending && revoke.variables === inv.id} onClick={() => revoke.mutate(inv.id)}>
                          Revoke
                        </Button>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}
