import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, LayoutDashboard, PartyPopper, Receipt, Sparkles, UserRound } from "lucide-react";
import { Link } from "react-router-dom";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Callout } from "@/components/ui/feedback";
import { JobStatus } from "@/features/merchant-dashboard/components/common";
import { api, errorMessage } from "@/lib/api";
import { formatNumber, titleCase } from "@/lib/utils";

import { onboardingKeys, SETUP_STEPS } from "../onboarding-api";
import type { FinishResult, OnboardingStatus } from "../types";

const JOB_LABEL: Record<string, string> = {
  embedding_reindex: "Product search index",
  expiry_reevaluation: "Expiry risk check",
  forecast_refresh: "Demand forecasts",
  analytics_refresh: "Cross-selling & insights",
  fraud_scan: "Fraud scan",
};

export function FinishStep({ status, onBack, onGoTo }: { status: OnboardingStatus; onBack: () => void; onGoTo: (key: (typeof SETUP_STEPS)[number]["key"]) => void }) {
  const qc = useQueryClient();
  const run = useMutation({
    mutationFn: () => api.post<FinishResult>("/merchant/onboarding/finish"),
    onSuccess: (r) => {
      qc.setQueryData(onboardingKeys.status, r.status);
      void qc.invalidateQueries({ queryKey: ["merchant"] });
      toast.success("First analytics started", { description: "Results appear on the dashboard as each job finishes." });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const missing = SETUP_STEPS.filter((s) => !status.steps[s.key]);
  const result = run.data;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Sparkles className="size-4 text-primary" aria-hidden /> Go live
        </CardTitle>
        <CardDescription>
          We generate product images, build the product search index and run the first forecasts, expiry checks, cross-selling analysis and fraud scan on
          your data.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {missing.length > 0 && (
          <Callout tone="warning" title="Some steps are not finished">
            <span>You can run analytics now, but results are better once these are done: </span>
            <span className="inline-flex flex-wrap gap-x-2">
              {missing.map((s) => (
                <Button key={s.key} variant="link" size="sm" className="h-auto" onClick={() => onGoTo(s.key)}>
                  {s.title}
                </Button>
              ))}
            </span>
          </Callout>
        )}
        <Button size="lg" onClick={() => run.mutate()} loading={run.isPending}>
          <Sparkles /> {result ? "Run analytics again" : "Run first analytics"}
        </Button>

        {result && (
          <div className="space-y-2" aria-label="Analytics jobs">
            <p className="text-sm text-muted-foreground">
              {result.images_generated > 0 ? `${formatNumber(result.images_generated)} product images generated. ` : ""}
              {Object.keys(result.jobs).length} background jobs queued:
            </p>
            {Object.entries(result.jobs).map(([type, job]) => (
              <JobStatus key={job.id} jobId={job.id} label={JOB_LABEL[type] ?? titleCase(type)} />
            ))}
          </div>
        )}

        {result && (
          <div className="rounded-lg border border-success/30 bg-success-soft p-4">
            <p className="flex items-center gap-2 text-lg font-semibold text-success">
              <PartyPopper className="size-5" aria-hidden /> Your store is live
            </p>
            <p className="mt-1 text-sm text-foreground/80">Dashboards fill in as the jobs above finish. Here is what to try next.</p>
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              <Button asChild>
                <Link to="/merchant">
                  <LayoutDashboard /> Open dashboard
                </Link>
              </Button>
              <Button asChild variant="outline">
                <Link to="/merchant/channels">
                  <Receipt /> Ring up a test bill
                </Link>
              </Button>
            </div>
            <div className="mt-3 flex gap-3 rounded-md border border-border bg-surface p-3 text-sm">
              <UserRound className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
              <div>
                <p className="font-medium">See your store as a shopper</p>
                <p className="text-muted-foreground">
                  Sign out, sign in with a shopper account and pick your new store in the store selector. Shoppers can search your catalog, build lists and
                  get an aisle-by-aisle route on your floor plan.
                </p>
              </div>
            </div>
          </div>
        )}
      </CardContent>
      <CardFooter>
        <Button variant="ghost" onClick={onBack}>
          <ArrowLeft /> Back
        </Button>
      </CardFooter>
    </Card>
  );
}
