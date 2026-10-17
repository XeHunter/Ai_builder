/**
 * Live shopping list: REST snapshot in the TanStack Query cache, kept current by the list WebSocket
 * or, on Firebase Hosting deployments, by a Firestore listener (`FirestoreListChannel`, same contract).
 *
 * Events are folded into the cached list immediately (`applyListEvent`), then a debounced REST refetch
 * fills in product cards and server-derived fields. The query's structural sharing refuses to replace
 * the cache with an older list version, so a slow refetch can never roll back newer live state.
 * Check-off / quantity / remove operations go over the socket with an optimistic overlay that is
 * cleared on ack (or reverted with a toast on error).
 */
import { replaceEqualDeep, useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import { toast } from "sonner";

import { useAuth } from "@/features/auth/auth-context";
import { api } from "@/lib/api";
import { getFirestoreSession } from "@/lib/firebase";
import { FirestoreListChannel } from "@/lib/list-firestore";
import { ListSocket, type ListOperation, type ListSocketHandlers, type SocketStatus } from "@/lib/list-socket";
import type { ShoppingListView } from "@/types/api";

import { applyListEvents, needsProductData, upsertItem, withOverrides } from "./list-events";
import type { ItemOverride, ItemPayload } from "./types";

export const listKey = (id: string) => ["shopping-list", id] as const;

interface ListChannel {
  connect(): void | Promise<void>;
  send(op: ListOperation): string;
  close(): void;
}

export function useLiveList(listId: string) {
  const qc = useQueryClient();
  const { me } = useAuth();
  const meId = me?.user.id ?? null;
  const meName = me?.user.full_name ?? "";
  const key = React.useMemo(() => listKey(listId), [listId]);
  const query = useQuery({
    queryKey: key,
    queryFn: () => api.get<ShoppingListView>(`/shopping-lists/${listId}`),
    structuralSharing: (oldData, newData) => {
      const o = oldData as ShoppingListView | undefined;
      const n = newData as ShoppingListView;
      if (o && n && o.id === n.id && n.version < o.version) return o;
      return replaceEqualDeep(oldData, newData);
    },
  });

  const [status, setStatus] = React.useState<SocketStatus>("connecting");
  const [online, setOnline] = React.useState<{ user_id: string; name: string }[]>([]);
  const [overrides, setOverrides] = React.useState<Record<string, ItemOverride>>({});
  const [deleted, setDeleted] = React.useState(false);
  const [accessError, setAccessError] = React.useState<string | null>(null);
  const socketRef = React.useRef<ListChannel | null>(null);
  const cidToItem = React.useRef(new Map<string, string>());
  const refetchTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearOverride = React.useCallback((cid: string) => {
    const itemId = cidToItem.current.get(cid);
    cidToItem.current.delete(cid);
    if (!itemId) return;
    setOverrides((cur) => {
      if (cur[itemId]?.cid !== cid) return cur; // superseded by a newer local change
      const next = { ...cur };
      delete next[itemId];
      return next;
    });
  }, []);

  React.useEffect(() => {
    const scheduleRefetch = (delay = 400) => {
      if (refetchTimer.current) clearTimeout(refetchTimer.current);
      refetchTimer.current = setTimeout(() => void qc.invalidateQueries({ queryKey: key, exact: true }), delay);
    };
    const handlers: ListSocketHandlers = {
      onSnapshot: (list) => qc.setQueryData(key, list as ShoppingListView),
      onEvents: (events) => {
        if (!events.length) return;
        const cur = qc.getQueryData<ShoppingListView>(key);
        if (!cur) {
          scheduleRefetch();
          return;
        }
        const next = applyListEvents(cur, events);
        qc.setQueryData(key, next);
        // Product cards, list status and members are server-derived: reconcile shortly after any change
        // (sooner when an item references a product we have no card for).
        scheduleRefetch(needsProductData(next) ? 150 : 600);
      },
      onAck: (ack) => {
        clearOverride(ack.client_event_id);
        const item = ack.item as ItemPayload | null;
        if (item?.id) qc.setQueryData<ShoppingListView>(key, (old) => (old ? upsertItem(old, item) : old));
      },
      onError: (err) => {
        if (err.client_event_id) {
          clearOverride(err.client_event_id);
          toast.error(err.message || "That change could not be saved");
          scheduleRefetch();
        } else if (err.code === "forbidden") {
          setAccessError(err.message);
        } else {
          toast.error(err.message);
        }
      },
      onPresence: setOnline,
      onStatus: setStatus,
      onDeleted: () => setDeleted(true),
    };
    let cancelled = false;
    let channel: ListChannel | null = null;
    void (async () => {
      const fs = meId ? await getFirestoreSession(meId) : null;
      if (cancelled) return;
      channel = fs
        ? new FirestoreListChannel(listId, handlers, fs.db, { uid: fs.uid, name: meName })
        : new ListSocket(listId, handlers);
      socketRef.current = channel;
      void channel.connect();
    })();
    return () => {
      cancelled = true;
      channel?.close();
      socketRef.current = null;
      if (refetchTimer.current) clearTimeout(refetchTimer.current);
    };
  }, [listId, key, qc, clearOverride, meId, meName]);

  /** Send an operation over the socket; `override` is shown immediately until the server acks. */
  const sendOp = React.useCallback((op: ListOperation, override?: Omit<ItemOverride, "cid">) => {
    const socket = socketRef.current;
    if (!socket) return;
    const cid = socket.send(op);
    if (override && "item_id" in op) {
      cidToItem.current.set(cid, op.item_id);
      setOverrides((cur) => ({ ...cur, [op.item_id]: { ...cur[op.item_id], ...override, cid } }));
    }
  }, []);

  const list = query.data;
  const items = React.useMemo(() => (list ? withOverrides(list.items, overrides) : []), [list, overrides]);
  const pendingChanges = Object.keys(overrides).length;

  return { query, list, items, status, online, sendOp, pendingChanges, deleted, accessError };
}
