import type { ListEvent } from "@/lib/list-socket";
import type { ListItem } from "@/types/api";

/** Item view as sent in events/acks: the same as ListItem but without the product card. */
export type ItemPayload = Partial<ListItem> & { id: string };

export interface OperationResult {
  event: ListEvent;
  item: ItemPayload | null;
  list_version: number;
}

export interface InvitationOut {
  id: string;
  role: string;
  expires_at: string;
  max_uses: number;
  use_count: number;
  revoked: boolean;
  created_at: string;
}

export interface InvitationPreview {
  list_name: string;
  owner_name: string;
  role: string;
  expires_at: string;
  item_count: number;
}

/** Local optimistic change for an item awaiting server acknowledgement. */
export interface ItemOverride {
  cid: string;
  status?: ListItem["status"];
  quantity?: number;
  removed?: boolean;
}
