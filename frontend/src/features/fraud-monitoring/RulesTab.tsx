import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";
import { z } from "zod";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { ErrorState, SkeletonRows } from "@/components/ui/feedback";
import { Field, Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/menu";
import { Provenance } from "@/components/ui/data";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { useAuth } from "@/features/auth/auth-context";
import { api, errorMessage } from "@/lib/api";
import { titleCase } from "@/lib/utils";

import type { FraudRule } from "./types";

export const ruleSchema = z.object({
  weight: z.number({ message: "Enter a number" }).int("Whole number").min(0, "0 – 100").max(100, "0 – 100"),
  params: z.record(z.string(), z.number({ message: "Enter a number" }).min(0, "Must be ≥ 0")),
  is_active: z.boolean(),
});

export function RulesTab() {
  const { can } = useAuth();
  const q = useQuery({ queryKey: ["merchant", "fraud-rules"], queryFn: () => api.get<FraudRule[]>("/merchant/fraud/rules") });
  const [editing, setEditing] = React.useState<FraudRule | null>(null);
  const canEdit = can("settings.manage");
  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-start justify-between gap-2">
        <div>
          <CardTitle>Detection rules</CardTitle>
          <CardDescription>Each fired rule adds its weight to the rule score. Receipt mismatch and duplicate receipt always open a case.</CardDescription>
        </div>
        <Provenance kind="rule" />
      </CardHeader>
      <CardContent className="px-0">
        {q.isLoading ? (
          <SkeletonRows className="px-5" />
        ) : q.isError ? (
          <ErrorState error={q.error} onRetry={() => void q.refetch()} className="mx-5" />
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>Rule</TH>
                <TH className="text-right">Weight</TH>
                <TH>Parameters</TH>
                <TH>Status</TH>
                <TH><span className="sr-only">Actions</span></TH>
              </TR>
            </THead>
            <TBody>
              {q.data!.map((r) => (
                <TR key={r.id}>
                  <TD>
                    <p className="font-medium">{r.name}</p>
                    <p className="text-xs text-muted-foreground">{r.description}</p>
                  </TD>
                  <TD className="tabular text-right font-semibold">{r.weight}</TD>
                  <TD className="text-xs">
                    {Object.keys(r.params).length ? Object.entries(r.params).map(([k, v]) => <div key={k}>{titleCase(k)}: <span className="tabular font-medium">{v}</span></div>) : <span className="text-muted-foreground">—</span>}
                  </TD>
                  <TD>{r.is_active ? <Badge variant="success">Active</Badge> : <Badge>Inactive</Badge>}</TD>
                  <TD className="text-right">
                    {canEdit && (
                      <Button size="sm" variant="ghost" onClick={() => setEditing(r)} aria-label={`Edit ${r.name}`}>
                        <Pencil /> Edit
                      </Button>
                    )}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
        {!canEdit && <p className="px-5 pt-3 text-xs text-muted-foreground">Editing rules requires the settings.manage permission.</p>}
      </CardContent>
      <Dialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)}>
        {editing && (
          <DialogContent title={`Edit: ${editing.name}`} description={editing.description} size="sm">
            <RuleEditor rule={editing} onDone={() => setEditing(null)} />
          </DialogContent>
        )}
      </Dialog>
    </Card>
  );
}

function RuleEditor({ rule, onDone }: { rule: FraudRule; onDone: () => void }) {
  const qc = useQueryClient();
  const [weight, setWeight] = React.useState(String(rule.weight));
  const [params, setParams] = React.useState<Record<string, string>>(() => Object.fromEntries(Object.entries(rule.params).map(([k, v]) => [k, String(v)])));
  const [active, setActive] = React.useState(rule.is_active);
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const save = useMutation({
    mutationFn: (body: z.infer<typeof ruleSchema>) => api.patch(`/merchant/fraud/rules/${rule.id}`, body),
    onSuccess: () => {
      toast.success(`${rule.name} updated. Applies from the next scan.`);
      void qc.invalidateQueries({ queryKey: ["merchant", "fraud-rules"] });
      onDone();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = ruleSchema.safeParse({
      weight: weight === "" ? NaN : Number(weight),
      params: Object.fromEntries(Object.entries(params).map(([k, v]) => [k, v === "" ? NaN : Number(v)])),
      is_active: active,
    });
    if (!parsed.success) {
      const errs: Record<string, string> = {};
      for (const issue of parsed.error.issues) errs[issue.path.join(".")] = issue.message;
      setErrors(errs);
      return;
    }
    setErrors({});
    save.mutate(parsed.data);
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
      <Field label="Weight (0 – 100)" htmlFor="rule-weight" error={errors.weight}>
        <Input id="rule-weight" type="number" min={0} max={100} value={weight} aria-invalid={!!errors.weight} onChange={(e) => setWeight(e.target.value)} />
      </Field>
      {Object.keys(params).map((k) => (
        <Field key={k} label={titleCase(k)} htmlFor={`rule-${k}`} error={errors[`params.${k}`]}>
          <Input id={`rule-${k}`} type="number" min={0} value={params[k]} aria-invalid={!!errors[`params.${k}`]} onChange={(e) => setParams((p) => ({ ...p, [k]: e.target.value }))} />
        </Field>
      ))}
      <label className="flex items-center justify-between gap-3 text-sm font-medium">
        Active
        <Switch checked={active} onCheckedChange={setActive} aria-label="Rule active" />
      </label>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone}>Cancel</Button>
        <Button type="submit" loading={save.isPending}>Save rule</Button>
      </DialogFooter>
    </form>
  );
}
