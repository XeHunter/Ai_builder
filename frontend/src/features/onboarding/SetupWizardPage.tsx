/**
 * Store-owner setup wizard ("plug and play"): store details → floor plan → products & stock → sales history →
 * channels → first analytics. Progress comes from GET /merchant/onboarding/status, so the wizard resumes at the
 * first unfinished step and completed steps can be revisited.
 */
import { Check, Lock } from "lucide-react";
import * as React from "react";

import { PageHeader } from "@/components/ui/data";
import { ErrorState, Progress, SkeletonRows } from "@/components/ui/feedback";
import { useMerchantStore } from "@/hooks/use-stores";
import { cn } from "@/lib/utils";

import { firstIncomplete, SETUP_STEPS, useOnboardingStatus, WIZARD_ORDER, type WizardStep } from "./onboarding-api";
import { CatalogStep } from "./steps/CatalogStep";
import { ChannelsStep } from "./steps/ChannelsStep";
import { FinishStep } from "./steps/FinishStep";
import { HistoryStep } from "./steps/HistoryStep";
import { LayoutStep } from "./steps/LayoutStep";
import { StoreStep } from "./steps/StoreStep";
import type { OnboardingStatus } from "./types";

const LABELS: Record<WizardStep, string> = { ...Object.fromEntries(SETUP_STEPS.map((s) => [s.key, s.title])), finish: "Go live" } as Record<WizardStep, string>;

export default function SetupWizardPage() {
  const status = useOnboardingStatus();

  return (
    <div>
      <PageHeader
        eyebrow="Getting started"
        title="Set up your store"
        description="Five short steps from an empty account to live dashboards, shopper navigation and AI insights. Your progress is saved as you go."
      />
      {status.isLoading ? (
        <SkeletonRows rows={6} />
      ) : status.isError ? (
        <ErrorState error={status.error} onRetry={() => void status.refetch()} />
      ) : status.data ? (
        <Wizard status={status.data} />
      ) : null}
    </div>
  );
}

function Wizard({ status }: { status: OnboardingStatus }) {
  const merchantStore = useMerchantStore();
  // Start at the first unfinished step; afterwards only the user moves the wizard (finishing a step never jumps ahead).
  const [current, setCurrent] = React.useState<WizardStep>(() => firstIncomplete(status.steps));
  const [chosenStore, setChosenStore] = React.useState<string | null>(null);
  const [furthest, setFurthest] = React.useState(0);
  const topRef = React.useRef<HTMLDivElement>(null);

  const steps = status.steps;
  const resumeAt = firstIncomplete(steps);
  const currentIndex = WIZARD_ORDER.indexOf(current);
  const reach = Math.max(furthest, WIZARD_ORDER.indexOf(resumeAt), currentIndex);
  const doneCount = SETUP_STEPS.filter((s) => steps[s.key]).length;

  const has = (id: string | null | undefined) => Boolean(id && status.stores.some((s) => s.id === id));
  const storeId = has(chosenStore) ? chosenStore : has(merchantStore.storeId) ? merchantStore.storeId : (status.stores[0]?.id ?? null);
  const store = status.stores.find((s) => s.id === storeId) ?? null;

  const canOpen = (step: WizardStep, i: number) => step === "store" || (Boolean(storeId) && (i <= reach || step === "finish" || steps[step as keyof typeof steps]));
  const go = (step: WizardStep) => {
    const i = WIZARD_ORDER.indexOf(step);
    setFurthest((f) => Math.max(f, i));
    setCurrent(step);
    topRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  };
  const nav = (i: number) => ({
    onBack: i > 0 ? () => go(WIZARD_ORDER[i - 1]) : undefined,
    onNext: () => go(WIZARD_ORDER[i + 1]),
  });
  const selectStore = (id: string) => {
    setChosenStore(id);
    merchantStore.setStoreId(id);
  };

  return (
    <div className="space-y-4">
      <div ref={topRef} className="scroll-mt-20 space-y-2">
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">
            <span className="tabular font-medium text-foreground">{doneCount}</span> of {SETUP_STEPS.length} steps done
          </span>
          {store && (
            <span className="truncate text-muted-foreground">
              Store: <span className="font-medium text-foreground">{store.name}</span>
            </span>
          )}
        </div>
        <Progress value={(doneCount / SETUP_STEPS.length) * 100} label="Setup progress" />
      </div>

      <nav aria-label="Setup steps">
        <ol className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
          {WIZARD_ORDER.map((step, i) => {
            const done = step === "finish" ? status.complete : steps[step];
            const isCurrent = step === current;
            const open = canOpen(step, i);
            return (
              <li key={step}>
                <button
                  type="button"
                  onClick={() => go(step)}
                  disabled={!open}
                  aria-current={isCurrent ? "step" : undefined}
                  aria-label={`Step ${i + 1}: ${LABELS[step]}${done ? " (done)" : ""}`}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm transition-colors disabled:cursor-not-allowed",
                    isCurrent && "border-primary bg-primary-soft text-primary",
                    !isCurrent && done && "border-success/40 text-success hover:bg-success-soft",
                    !isCurrent && !done && open && "border-border text-foreground hover:bg-muted",
                    !isCurrent && !done && !open && "border-border text-muted-foreground opacity-70",
                  )}
                >
                  <span
                    className={cn(
                      "tabular flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold",
                      done ? "bg-success text-white" : isCurrent ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground",
                    )}
                    aria-hidden
                  >
                    {done ? <Check className="size-3.5" /> : !open ? <Lock className="size-3" /> : i + 1}
                  </span>
                  <span className="min-w-0 truncate font-medium">{LABELS[step]}</span>
                </button>
              </li>
            );
          })}
        </ol>
      </nav>

      {current === "store" && <StoreStep stores={status.stores} storeId={storeId} onSelect={selectStore} done={steps.store} {...nav(0)} />}
      {storeId && current === "layout" && <LayoutStep key={storeId} storeId={storeId} storeName={store?.name} done={steps.layout} {...nav(1)} />}
      {storeId && current === "catalog" && (
        <CatalogStep key={storeId} storeId={storeId} storeCode={store?.code} done={steps.catalog} hasLayout={steps.layout} counts={status.counts} {...nav(2)} />
      )}
      {storeId && current === "history" && <HistoryStep key={storeId} storeId={storeId} storeCode={store?.code} done={steps.history} sales={status.counts.sales} {...nav(3)} />}
      {storeId && current === "channels" && <ChannelsStep key={storeId} storeId={storeId} done={steps.channels} apiKeys={status.counts.api_keys} {...nav(4)} />}
      {storeId && current === "finish" && <FinishStep status={status} onBack={() => go("channels")} onGoTo={go} />}
    </div>
  );
}
