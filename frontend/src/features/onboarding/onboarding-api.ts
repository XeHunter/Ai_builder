/** Query keys, hooks and step metadata shared by the onboarding pages. */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";

import { api } from "@/lib/api";

import type { OnboardingStatus, StepKey } from "./types";

export const onboardingKeys = {
  status: ["merchant", "onboarding", "status"] as const,
};

export const SETUP_STEPS: { key: StepKey; title: string; blurb: string }[] = [
  { key: "store", title: "Store details", blurb: "Name and location, so shoppers nearby can find you." },
  { key: "layout", title: "Floor plan", blurb: "Pick aisles and walls; we draw the map for in-store navigation." },
  { key: "catalog", title: "Products & stock", blurb: "Start from a grocery catalog or import your billing/ERP export." },
  { key: "history", title: "Sales history", blurb: "Past bills power forecasting, cross-selling and fraud checks." },
  { key: "channels", title: "Connect channels", blurb: "Plug in your POS and online store so every bill flows in live." },
];

export type WizardStep = StepKey | "finish";
export const WIZARD_ORDER: WizardStep[] = [...SETUP_STEPS.map((s) => s.key), "finish"];

/** First step that is not done yet ("finish" when all five are). */
export function firstIncomplete(steps: Record<StepKey, boolean> | undefined): WizardStep {
  if (!steps) return "store";
  return SETUP_STEPS.find((s) => !steps[s.key])?.key ?? "finish";
}

export function useOnboardingStatus() {
  return useQuery({ queryKey: onboardingKeys.status, queryFn: () => api.get<OnboardingStatus>("/merchant/onboarding/status") });
}

/** Refresh the setup checklist plus whatever the given step changed. */
export function useRefreshSetup() {
  const qc = useQueryClient();
  return React.useCallback(
    (...extra: (readonly unknown[])[]) => {
      void qc.invalidateQueries({ queryKey: onboardingKeys.status });
      for (const key of extra) void qc.invalidateQueries({ queryKey: key });
    },
    [qc],
  );
}

/** Upload a CSV string as a multipart `file` field. */
export function csvForm(text: string, filename: string): FormData {
  const fd = new FormData();
  fd.append("file", new File([text], filename, { type: "text/csv" }));
  return fd;
}
