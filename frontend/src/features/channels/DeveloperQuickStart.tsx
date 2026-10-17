/** Endpoints and copy-paste curl examples for POS vendors and storefront developers. */
import { Code2 } from "lucide-react";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

import { CodeSnippet, CopyButton } from "./CopyButton";
import type { ChannelsOverview } from "./types";

const KEY = "<your-api-key>";

export function DeveloperQuickStart({ endpoints, storeCode, className }: { endpoints: ChannelsOverview["endpoints"]; storeCode: string; className?: string }) {
  const sampleOrder = JSON.stringify({ external_id: "BILL-1001", store_code: storeCode, channel: "pos", items: [{ sku: "MLK-001", quantity: 2 }] });
  const shopifyUrl = `${endpoints.shopify_orders}?store_code=${encodeURIComponent(storeCode)}`;
  const catalogUrl = `${endpoints.catalog_feed}?store_code=${encodeURIComponent(storeCode)}`;
  const rows: [string, string][] = [
    ["Orders API (POST)", endpoints.orders],
    ["Shopify webhook (POST)", shopifyUrl],
    ["Catalog feed (GET)", catalogUrl],
  ];

  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Code2 className="size-4 text-primary" aria-hidden /> Developer quick start
        </CardTitle>
        <CardDescription>
          Every request carries an <code className="font-mono text-xs">X-Api-Key</code> header. Orders are idempotent on <code className="font-mono text-xs">external_id</code>, so retries never double-count stock.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <ul className="space-y-2">
          {rows.map(([label, url]) => (
            <li key={label} className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-3">
              <span className="w-48 shrink-0 text-xs font-medium text-muted-foreground">{label}</span>
              <code className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1 font-mono text-xs" title={url}>
                {url}
              </code>
              <CopyButton text={url} label={`Copy ${label} URL`} />
            </li>
          ))}
        </ul>

        <Tabs defaultValue="orders">
          <TabsList>
            <TabsTrigger value="orders">Push a bill</TabsTrigger>
            <TabsTrigger value="shopify">Shopify</TabsTrigger>
            <TabsTrigger value="catalog">Catalog feed</TabsTrigger>
          </TabsList>
          <TabsContent value="orders" className="space-y-2">
            <p className="text-sm text-muted-foreground">Call this from your billing software (or a small sync agent) after each bill. Stock is consumed FEFO and the order appears in the live feed instantly.</p>
            <CodeSnippet
              label="Copy orders curl example"
              code={`curl -X POST ${endpoints.orders} -H "X-Api-Key: ${KEY}" -H "Content-Type: application/json" -d '${sampleOrder}'`}
            />
          </TabsContent>
          <TabsContent value="shopify" className="space-y-2">
            <p className="text-sm text-muted-foreground">
              In Shopify admin → Settings → Notifications → Webhooks, create an <strong>Order creation</strong> webhook (JSON) pointing at this URL. Line-item SKUs are matched to your catalog.
            </p>
            <CodeSnippet label="Copy Shopify webhook URL" code={shopifyUrl} />
            <p className="text-xs text-muted-foreground">
              Send the key as a header <code className="font-mono">X-Api-Key: {KEY}</code> (or via your webhook relay).
            </p>
          </TabsContent>
          <TabsContent value="catalog" className="space-y-2">
            <p className="text-sm text-muted-foreground">Pull live prices (including approved markdowns and promotions), stock and shelf locations for your website or app.</p>
            <CodeSnippet label="Copy catalog curl example" code={`curl ${catalogUrl} -H "X-Api-Key: ${KEY}"`} />
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}
