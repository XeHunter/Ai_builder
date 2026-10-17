/**
 * Reconnecting WebSocket client for a shared shopping list.
 *
 * - Tracks the last applied event sequence number and reconnects with `?last_seq=N`, so the server
 *   replies with only the missed events (or a full snapshot after a long gap).
 * - Operations carry a `client_event_id`; the server de-duplicates retries, so an operation that was
 *   sent just before a disconnect is safe to resend.
 * - Exponential backoff with jitter, capped at 15 s.
 */
import { wsUrl } from "@/lib/api";
import { uid } from "@/lib/utils";

export type SocketStatus = "connecting" | "open" | "reconnecting" | "closed";

export interface ListSocketHandlers {
  onSnapshot: (list: unknown) => void;
  onEvents: (events: ListEvent[]) => void;
  onAck: (ack: { client_event_id: string; seq: number; item: unknown }) => void;
  onError: (err: { client_event_id?: string; code: string; message: string; details?: unknown }) => void;
  onPresence: (members: { user_id: string; name: string }[]) => void;
  onStatus: (status: SocketStatus) => void;
  onDeleted?: () => void;
}

export interface ListEvent {
  seq: number;
  type: string;
  item_id: string | null;
  actor_id: string | null;
  actor_name: string | null;
  payload: Record<string, unknown>;
  client_event_id: string | null;
  created_at: string;
}

export type ListOperation =
  | { op: "add_item"; raw_text?: string; product_id?: string; quantity?: number; unit?: string | null }
  | { op: "update_item"; item_id: string; quantity?: number; unit?: string | null; product_id?: string; expected_version?: number }
  | { op: "remove_item"; item_id: string }
  | { op: "collect"; item_id: string }
  | { op: "uncollect"; item_id: string };

export class ListSocket {
  private ws: WebSocket | null = null;
  private lastSeq: number | null = null;
  private attempts = 0;
  private closedByUser = false;
  private pending = new Map<string, Record<string, unknown>>();
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly listId: string;
  private readonly handlers: ListSocketHandlers;

  constructor(listId: string, handlers: ListSocketHandlers) {
    this.listId = listId;
    this.handlers = handlers;
  }

  connect(): void {
    this.closedByUser = false;
    this.handlers.onStatus(this.attempts ? "reconnecting" : "connecting");
    const q = this.lastSeq !== null ? `?last_seq=${this.lastSeq}` : "";
    const ws = new WebSocket(wsUrl(`/ws/shopping-lists/${this.listId}${q}`));
    this.ws = ws;
    ws.onopen = () => {
      this.attempts = 0;
      this.handlers.onStatus("open");
      for (const msg of this.pending.values()) ws.send(JSON.stringify(msg));
      this.pingTimer = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send('{"type":"ping"}'), 25_000);
    };
    ws.onmessage = (e) => this.handle(JSON.parse(e.data));
    ws.onclose = (e) => {
      if (this.pingTimer) clearInterval(this.pingTimer);
      if (this.closedByUser || e.code === 4401 || e.code === 4404) {
        this.handlers.onStatus("closed");
        if (e.code === 4404 || e.code === 4401) this.handlers.onError({ code: "forbidden", message: e.reason || "Access denied" });
        return;
      }
      this.handlers.onStatus("reconnecting");
      const delay = Math.min(15_000, 500 * 2 ** this.attempts) * (0.75 + Math.random() * 0.5);
      this.attempts += 1;
      this.retryTimer = setTimeout(() => this.connect(), delay);
    };
  }

  private handle(msg: Record<string, unknown>): void {
    switch (msg.type) {
      case "snapshot": {
        const list = msg.list as { version: number };
        this.lastSeq = list.version;
        this.handlers.onSnapshot(list);
        break;
      }
      case "events": {
        const events = msg.events as ListEvent[];
        if (events.length) this.lastSeq = events[events.length - 1].seq;
        this.handlers.onEvents(events);
        break;
      }
      case "event": {
        const ev = msg.event as ListEvent;
        if (this.lastSeq === null || ev.seq > this.lastSeq) this.lastSeq = ev.seq;
        this.handlers.onEvents([ev]);
        break;
      }
      case "ack":
        this.pending.delete(msg.client_event_id as string);
        this.handlers.onAck(msg as never);
        break;
      case "error":
        if (msg.client_event_id) this.pending.delete(msg.client_event_id as string);
        this.handlers.onError(msg as never);
        break;
      case "presence":
        this.handlers.onPresence((msg.members_online as { user_id: string; name: string }[]) ?? []);
        break;
      case "list_deleted":
        this.handlers.onDeleted?.();
        break;
    }
  }

  send(op: ListOperation): string {
    const client_event_id = uid();
    const msg = { type: "op", client_event_id, ...op };
    this.pending.set(client_event_id, msg);
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
    return client_event_id;
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  close(): void {
    this.closedByUser = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.ws?.close();
  }
}
