/** Renders one structured assistant answer: text, products, basket, complements, directions, provenance. */
import { CheckCircle2, HelpCircle, MapPin, ShieldAlert, ShieldCheck } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Provenance } from "@/components/ui/data";
import { Callout, Progress } from "@/components/ui/feedback";
import { formatCurrency, formatNumber, titleCase } from "@/lib/utils";
import type { AssistantResponse } from "@/types/api";

import { ProductTile } from "./ProductTile";

export function AssistantReply({ response, onQuickReply }: { response: AssistantResponse; onQuickReply?: (text: string) => void }) {
  const r = response;
  const basketProducts = r.basket ? r.products : [];
  const otherProducts = r.basket ? [] : r.products.filter((p) => p.id !== r.reference?.id);
  return (
    <div className="space-y-4">
      <p className="whitespace-pre-line text-sm leading-relaxed">{r.message}</p>

      {r.clarifying_question && (
        <Callout title="A quick question">
          <span className="flex items-start gap-2">
            <HelpCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
            {r.clarifying_question}
          </span>
        </Callout>
      )}

      {r.reference && (
        <div>
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">About</p>
          <ProductTile product={r.reference} compact className="max-w-xs" />
        </div>
      )}

      {r.basket && <BasketSummary basket={r.basket} />}

      {basketProducts.length > 0 && (
        <ReplyGrid title="Your basket">
          {basketProducts.map((p) => (
            <ProductTile
              key={p.id}
              product={p}
              compact
              extra={
                p.quantity != null || p.line_total != null ? (
                  <p className="tabular text-xs text-muted-foreground">
                    {p.slot && <span className="mr-1">For “{p.slot}” ·</span>}
                    {p.quantity != null && `${formatNumber(p.quantity, 2)} × `}
                    {p.line_total != null && <span className="font-medium text-foreground">{formatCurrency(p.line_total)}</span>}
                  </p>
                ) : null
              }
            />
          ))}
        </ReplyGrid>
      )}

      {otherProducts.length > 0 && (
        <ReplyGrid title={r.intent.intent === "similar_product" ? "Similar products" : "Products"}>
          {otherProducts.map((p) => (
            <ProductTile key={p.id} product={p} compact note={p.reason ?? undefined} />
          ))}
        </ReplyGrid>
      )}

      {r.complementary.length > 0 && (
        <ReplyGrid title="Goes well with">
          {r.complementary.map((p) => (
            <ProductTile key={p.id} product={p} compact note={p.reason ?? "Frequently bought together"} />
          ))}
        </ReplyGrid>
      )}

      {r.directions.length > 0 && (
        <div>
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Directions</p>
          <ul className="divide-y divide-border rounded-md border border-border">
            {r.directions.map((d) => (
              <li key={`${d.product_id}-${d.shelf_code}`} className="flex items-start gap-2 px-3 py-2 text-sm">
                <MapPin className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="font-medium">{d.name}</span>
                  <span className="block text-xs text-muted-foreground">
                    {d.aisle_label} · {d.fixture_label} · shelf <span className="font-mono">{d.shelf_code}</span> · level {d.level}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {r.unmatched.length > 0 && (
        <p className="text-sm text-muted-foreground">
          Not found in this store: {r.unmatched.join(", ")}.
          {onQuickReply && (
            <button type="button" className="ml-1 font-medium text-primary hover:underline" onClick={() => onQuickReply(`Find alternatives for ${r.unmatched.join(", ")}`)}>
              Suggest alternatives
            </button>
          )}
        </p>
      )}

      <ReplyMeta response={r} />
    </div>
  );
}

function ReplyGrid({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</p>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4">{children}</div>
    </div>
  );
}

function BasketSummary({ basket }: { basket: NonNullable<AssistantResponse["basket"]> }) {
  const pct = basket.budget ? (basket.total / basket.budget) * 100 : 0;
  return (
    <div className="rounded-lg border border-border bg-surface-raised p-3" aria-label="Basket summary">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-xs text-muted-foreground">
            {basket.occasion ? `${titleCase(basket.occasion)} basket` : "Basket"}
            {basket.people ? ` for ${basket.people}` : ""}
          </p>
          <p className="tabular text-lg font-semibold">
            {formatCurrency(basket.total)}
            {basket.budget != null && <span className="text-sm font-normal text-muted-foreground"> of {formatCurrency(basket.budget)} budget</span>}
          </p>
        </div>
        {basket.budget != null &&
          (basket.within_budget ? (
            <Badge variant="success">
              <CheckCircle2 className="size-3" aria-hidden /> Within budget
            </Badge>
          ) : (
            <Badge variant="danger">Over budget</Badge>
          ))}
      </div>
      {basket.budget != null && <Progress value={pct} className="mt-2" label="Share of budget used" />}
      {basket.skipped.length > 0 && (
        <p className="mt-2 text-xs text-muted-foreground">Left out to stay on budget: {basket.skipped.join(", ")}</p>
      )}
    </div>
  );
}

function ReplyMeta({ response }: { response: AssistantResponse }) {
  const { provider, grounding } = response;
  const kind = provider.kind === "deterministic" ? "deterministic" : "llm";
  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-border pt-2 text-xs text-muted-foreground">
      <Provenance kind={kind} detail={`Provider: ${provider.name}${provider.fell_back ? " (fell back to the rule-based provider)" : ""}`} />
      {grounding.validated ? (
        <Badge variant="success">
          <ShieldCheck className="size-3" aria-hidden /> Checked against store data
        </Badge>
      ) : (
        <Badge variant="warning" title={grounding.issues.join("; ")}>
          <ShieldAlert className="size-3" aria-hidden /> Not fully verified
        </Badge>
      )}
      {provider.fell_back && <span>AI provider unavailable — answered by the rule-based fallback.</span>}
      {!grounding.validated && grounding.issues.length > 0 && <span>{grounding.issues.join("; ")}</span>}
    </div>
  );
}
