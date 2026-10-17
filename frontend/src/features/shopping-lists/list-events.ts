/**
 * Pure state helpers for a live shopping list.
 *
 * - `applyListEvent` folds a server event into the list (idempotent: events at or below the list
 *   version are ignored, stale item versions never overwrite newer ones).
 * - Events carry item views *without* product cards, so the existing card is kept while the product
 *   is unchanged; callers refetch the list when `needsProductData` reports missing cards.
 * - `withOverrides` overlays optimistic changes that are waiting for an ack.
 * - `computeGroups` / `computeProgress` mirror the server's aisle grouping and progress maths so the
 *   UI stays consistent between refetches.
 */
import type { ListEvent } from "@/lib/list-socket";
import type { ListItem, ShoppingListView } from "@/types/api";

import type { ItemOverride, ItemPayload } from "./types";

const ITEM_DEFAULTS: Omit<ListItem, "id"> = {
  raw_text: "",
  display_name: "",
  product_id: null,
  quantity: 1,
  unit: null,
  status: "pending",
  match_confidence: null,
  candidates: [],
  position: 0,
  version: 0,
  collected_by_id: null,
  collected_at: null,
  updated_at: null,
  product: null,
};

export function mergeItem(existing: ListItem | undefined, incoming: ItemPayload): ListItem {
  if (!existing) return { ...ITEM_DEFAULTS, ...incoming, product: incoming.product ?? null } as ListItem;
  if (incoming.version !== undefined && incoming.version < existing.version) return existing;
  const productChanged = incoming.product_id !== undefined && incoming.product_id !== existing.product_id;
  const product = incoming.product ? incoming.product : productChanged ? null : existing.product;
  return { ...existing, ...incoming, product };
}

/** Insert or merge an item view (from an ack, REST result or event). */
export function upsertItem(list: ShoppingListView, incoming: ItemPayload): ShoppingListView {
  const idx = list.items.findIndex((i) => i.id === incoming.id);
  if (idx === -1) return { ...list, items: [...list.items, mergeItem(undefined, incoming)] };
  const merged = mergeItem(list.items[idx], incoming);
  if (merged === list.items[idx]) return list;
  const items = list.items.slice();
  items[idx] = merged;
  return { ...list, items };
}

export function applyListEvent(list: ShoppingListView, ev: ListEvent): ShoppingListView {
  if (ev.seq <= list.version) return list;
  let next: ShoppingListView = { ...list, version: ev.seq, updated_at: ev.created_at || list.updated_at };
  const item = ev.payload?.item as ItemPayload | undefined;
  switch (ev.type) {
    case "item_added":
    case "item_updated":
    case "item_collected":
    case "item_uncollected":
      if (item?.id) next = upsertItem(next, item);
      break;
    case "item_removed": {
      const id = ev.item_id ?? item?.id;
      if (id) next = { ...next, items: next.items.filter((i) => i.id !== id) };
      break;
    }
    case "member_joined": {
      const p = ev.payload as { user_id?: string; name?: string; role?: string };
      if (p.user_id && !next.members.some((m) => m.user_id === p.user_id)) {
        next = { ...next, is_shared: true, members: [...next.members, { user_id: p.user_id, name: p.name ?? "New member", role: p.role ?? "editor" }] };
      }
      break;
    }
    case "list_updated": {
      const p = ev.payload as { name?: string; status?: ShoppingListView["status"] };
      next = { ...next, ...(p.name ? { name: p.name } : {}), ...(p.status ? { status: p.status } : {}) };
      break;
    }
    default:
      break;
  }
  return { ...next, progress: computeProgress(next.items) };
}

export function applyListEvents(list: ShoppingListView, events: ListEvent[]): ShoppingListView {
  return [...events].sort((a, b) => a.seq - b.seq).reduce(applyListEvent, list);
}

/** True when an item references a product whose card we don't have yet (refetch needed). */
export function needsProductData(list: ShoppingListView): boolean {
  return list.items.some((i) => i.product_id && (!i.product || i.product.id !== i.product_id));
}

export function withOverrides(items: ListItem[], overrides: Record<string, ItemOverride>): ListItem[] {
  const out: ListItem[] = [];
  for (const it of items) {
    const o = overrides[it.id];
    if (!o) {
      out.push(it);
      continue;
    }
    if (o.removed) continue;
    out.push({ ...it, ...(o.status ? { status: o.status } : {}), ...(o.quantity !== undefined ? { quantity: o.quantity } : {}) });
  }
  return out;
}

export function computeProgress(items: ListItem[]): ShoppingListView["progress"] {
  const total = items.length;
  const collected = items.filter((i) => i.status === "collected").length;
  return {
    total,
    collected,
    unresolved: items.filter((i) => i.status === "unresolved").length,
    unavailable: items.filter((i) => i.status === "unavailable").length,
    percent: total ? Math.round((collected / total) * 100) : 0,
  };
}

function aisleSortKey(code: string): string {
  const m = /^([A-Z]+)(\d*)/.exec(code || "");
  if (!m) return code || "";
  const prefix: Record<string, string> = { P: "0", A: "1", E: "2", D: "3", Z: "4", CLR: "5" };
  return `${prefix[m[1]] ?? "9"}${String(Number(m[2] || 0)).padStart(3, "0")}`;
}

export interface ItemGroup {
  key: string;
  label: string;
  order: string;
  items: ListItem[];
}

/** Group items by aisle in walking order, matching the server's `groups` field. */
export function computeGroups(items: ListItem[]): ItemGroup[] {
  const groups = new Map<string, ItemGroup>();
  for (const it of [...items].sort((a, b) => a.position - b.position)) {
    let key: string;
    let label: string;
    let order: string;
    if (it.status === "unresolved" || !it.product_id) {
      [key, label, order] = ["unresolved", "Needs a product match", "zz1"];
    } else if (!it.product) {
      [key, label, order] = ["syncing", "Just added", "zz0a"];
    } else if (!it.product.location) {
      [key, label, order] = ["no_location", "Location unknown", "zz0"];
    } else {
      const loc = it.product.location;
      key = loc.aisle_code || loc.fixture_label;
      label = loc.aisle_label;
      order = aisleSortKey(key);
    }
    const g = groups.get(key) ?? { key, label, order, items: [] };
    g.items.push(it);
    groups.set(key, g);
  }
  return [...groups.values()].sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : 0));
}
