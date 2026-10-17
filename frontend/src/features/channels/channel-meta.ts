/** Labels, badge colours and small formatters shared by the channels page, live feed and simulator. */
import type { BadgeVariant } from "@/components/ui/badge";

import type { ChannelOrder } from "./types";

export const CHANNEL_META: Record<string, { label: string; variant: BadgeVariant }> = {
  pos: { label: "POS", variant: "primary" },
  self_checkout: { label: "Self-checkout", variant: "info" },
  online: { label: "Online", variant: "accent" },
};

export function channelLabel(channel: string): string {
  return CHANNEL_META[channel]?.label ?? channel.replace(/_/g, " ");
}

export const ORDERS_KEY = ["merchant", "channels", "orders"] as const;
export const CHANNELS_KEY = ["merchant", "channels", "overview"] as const;

/** "2× Amul Milk, 1× Bread +3 more" (falls back to the item count when lines are missing). */
export function itemSummary(order: Pick<ChannelOrder, "lines" | "item_count">, max = 2): string {
  const lines = order.lines ?? [];
  if (!lines.length) return `${order.item_count} item${order.item_count === 1 ? "" : "s"}`;
  const head = lines.slice(0, max).map((l) => `${l.quantity}× ${l.name}`).join(", ");
  return lines.length > max ? `${head} +${lines.length - max} more` : head;
}

export async function copyText(text: string): Promise<boolean> {
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
