import { CloudRain, Settings2, Tag, WandSparkles } from "lucide-react";
import { useSearchParams } from "react-router-dom";

import { PageHeader } from "@/components/ui/data";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

import { PriceChangeDrawer } from "./components/PriceChangeDrawer";
import { PriceChangesTab } from "./components/PriceChangesTab";
import { PromotionsTab } from "./components/PromotionsTab";
import { RulesPolicyTab } from "./components/RulesPolicyTab";
import { WeatherTab } from "./components/WeatherTab";

const TABS = ["changes", "promotions", "weather", "rules"] as const;
type Tab = (typeof TABS)[number];

export default function PricingPage() {
  const [params, setParams] = useSearchParams();
  const changeId = params.get("change");
  const promotionId = params.get("promotion");
  const requested = params.get("tab") as Tab | null;
  const tab: Tab = requested && TABS.includes(requested) ? requested : promotionId ? "promotions" : "changes";

  const update = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    setParams(next, { replace: true });
  };

  return (
    <div>
      <PageHeader
        eyebrow="Revenue management"
        title="Pricing & promotions"
        description="Review markdown recommendations, approve and publish price changes, run guarded promotions and configure the rules behind them."
      />
      <Tabs value={tab} onValueChange={(t) => update({ tab: t })}>
        <TabsList>
          <TabsTrigger value="changes">
            <WandSparkles /> Price changes
          </TabsTrigger>
          <TabsTrigger value="promotions">
            <Tag /> Promotions
          </TabsTrigger>
          <TabsTrigger value="weather">
            <CloudRain /> Weather opportunities
          </TabsTrigger>
          <TabsTrigger value="rules">
            <Settings2 /> Rules & policy
          </TabsTrigger>
        </TabsList>
        <TabsContent value="changes">
          <PriceChangesTab onOpen={(id) => update({ change: id })} />
        </TabsContent>
        <TabsContent value="promotions">
          <PromotionsTab openId={promotionId} onOpen={(id) => update({ promotion: id, tab: "promotions" })} />
        </TabsContent>
        <TabsContent value="weather">
          <WeatherTab onPromotionCreated={(p) => update({ tab: "promotions", promotion: p.id })} />
        </TabsContent>
        <TabsContent value="rules">
          <RulesPolicyTab />
        </TabsContent>
      </Tabs>
      {/* Rendered outside the tabs so ?change= deep links work from any tab. */}
      <PriceChangeDrawer changeId={changeId} onClose={() => update({ change: null })} />
    </div>
  );
}
