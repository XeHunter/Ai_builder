/**
 * Shared-list channel over Firestore (used when the app is served from Firebase Hosting + Cloud Run).
 *
 * Same contract as `ListSocket`, different transport:
 * - Reads: the API mirrors every list event to `shoppingLists/{listId}/events/{seq}`; we listen for
 *   events after the REST snapshot's version, in `seq` order, and hand them to the same reducer.
 * - Writes: operations go to the REST endpoints (the API validates, versions and persists them, then
 *   mirrors the resulting event). The REST reply is the ack; `client_event_id` makes retries safe.
 * - Presence: each member heartbeats `shoppingLists/{listId}/presence/{uid}`.
 * Firestore security rules only let list members read these documents.
 */
import type { Firestore, Unsubscribe } from "firebase/firestore";

import { api, ApiError } from "@/lib/api";
import type { ListEvent, ListOperation, ListSocketHandlers } from "@/lib/list-socket";
import { uid } from "@/lib/utils";

const PRESENCE_EVERY_MS = 30_000;
const PRESENCE_FRESH_MS = 75_000;

interface OpResult {
  event: ListEvent;
  item: unknown;
  list_version: number;
}

export class FirestoreListChannel {
  private lastSeq = 0;
  private unsubs: Unsubscribe[] = [];
  private pending = new Map<string, ListOperation>();
  private presenceTimer: ReturnType<typeof setInterval> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private attempts = 0;
  private readonly listId: string;
  private readonly handlers: ListSocketHandlers;
  private readonly db: Firestore;
  private readonly me: { uid: string; name: string };

  constructor(listId: string, handlers: ListSocketHandlers, db: Firestore, me: { uid: string; name: string }) {
    this.listId = listId;
    this.handlers = handlers;
    this.db = db;
    this.me = me;
  }

  async connect(): Promise<void> {
    this.closed = false;
    this.handlers.onStatus(this.attempts ? "reconnecting" : "connecting");
    try {
      const fs = await import("firebase/firestore");
      const { collection, doc, onSnapshot, orderBy, query, serverTimestamp, setDoc, where } = fs;
      await api.post(`/realtime/lists/${this.listId}/subscribe`);
      const snapshot = await api.get<{ version: number }>(`/shopping-lists/${this.listId}`);
      if (this.closed) return;
      this.lastSeq = snapshot.version;
      this.handlers.onSnapshot(snapshot);

      const listRef = doc(this.db, "shoppingLists", this.listId);
      this.unsubs.push(
        onSnapshot(
          listRef,
          (d) => {
            const data = d.data();
            if (data?.deleted) this.handlers.onDeleted?.();
            else if (data?.members && !(data.members as string[]).includes(this.me.uid)) {
              this.handlers.onError({ code: "forbidden", message: "You are no longer a member of this list" });
            }
          },
          (err) => this.fail(err),
        ),
      );
      const events = query(collection(listRef, "events"), where("seq", ">", this.lastSeq), orderBy("seq"));
      this.unsubs.push(
        onSnapshot(
          events,
          (snap) => {
            const fresh = snap
              .docChanges()
              .filter((c) => c.type === "added")
              .map((c) => c.doc.data() as ListEvent)
              .filter((e) => e.seq > this.lastSeq)
              .sort((a, b) => a.seq - b.seq);
            if (!fresh.length) return;
            this.lastSeq = fresh[fresh.length - 1].seq;
            this.handlers.onEvents(fresh);
          },
          (err) => this.fail(err),
        ),
      );
      const presenceRef = collection(listRef, "presence");
      this.unsubs.push(
        onSnapshot(presenceRef, (snap) => {
          const now = Date.now();
          const online = snap.docs
            .map((d) => d.data() as { user_id: string; name: string; at?: { toMillis: () => number } })
            .filter((p) => p.at && now - p.at.toMillis() < PRESENCE_FRESH_MS)
            .map(({ user_id, name }) => ({ user_id, name }));
          this.handlers.onPresence(online);
        }),
      );
      const beat = () =>
        void setDoc(doc(presenceRef, this.me.uid), { user_id: this.me.uid, name: this.me.name, at: serverTimestamp() }).catch(
          () => undefined,
        );
      beat();
      this.presenceTimer = setInterval(beat, PRESENCE_EVERY_MS);
      this.attempts = 0;
      this.handlers.onStatus("open");
      for (const [cid, op] of this.pending) void this.deliver(cid, op);
    } catch (e) {
      this.fail(e);
    }
  }

  private fail(err: unknown): void {
    if (this.closed) return;
    if (err instanceof ApiError && (err.status === 403 || err.status === 404)) {
      this.handlers.onStatus("closed");
      this.handlers.onError({ code: "forbidden", message: err.message });
      return;
    }
    this.teardown();
    this.handlers.onStatus("reconnecting");
    const delay = Math.min(15_000, 500 * 2 ** this.attempts) * (0.75 + Math.random() * 0.5);
    this.attempts += 1;
    this.retryTimer = setTimeout(() => void this.connect(), delay);
  }

  send(op: ListOperation): string {
    const cid = uid();
    this.pending.set(cid, op);
    void this.deliver(cid, op);
    return cid;
  }

  private async deliver(cid: string, op: ListOperation): Promise<void> {
    const base = `/shopping-lists/${this.listId}/items`;
    try {
      let res: OpResult;
      switch (op.op) {
        case "add_item":
          res = await api.post<OpResult>(base, { raw_text: op.raw_text, product_id: op.product_id, quantity: op.quantity ?? 1, unit: op.unit }, { client_event_id: cid });
          break;
        case "update_item": {
          const { item_id, ...rest } = op;
          res = await api.patch<OpResult>(`${base}/${item_id}`, { ...rest, op: undefined, client_event_id: cid });
          break;
        }
        case "remove_item":
          res = await api.delete<OpResult>(`${base}/${op.item_id}`, { client_event_id: cid });
          break;
        case "collect":
        case "uncollect":
          res = await api.patch<OpResult>(`${base}/${op.item_id}`, {
            status: op.op === "collect" ? "collected" : "pending",
            client_event_id: cid,
          });
          break;
      }
      this.pending.delete(cid);
      this.handlers.onAck({ client_event_id: cid, seq: res.event.seq, item: res.item });
    } catch (e) {
      if (e instanceof ApiError && e.status === 0 && !this.closed) {
        setTimeout(() => this.pending.has(cid) && void this.deliver(cid, op), 2_000);
        return;
      }
      this.pending.delete(cid);
      const err = e instanceof ApiError ? e : new ApiError(0, "internal_error", String(e), null, null);
      this.handlers.onError({ client_event_id: cid, code: err.code, message: err.message, details: err.details });
    }
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  private teardown(): void {
    for (const u of this.unsubs) u();
    this.unsubs = [];
    if (this.presenceTimer) clearInterval(this.presenceTimer);
    this.presenceTimer = null;
  }

  close(): void {
    this.closed = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.teardown();
    this.handlers.onStatus("closed");
  }
}
