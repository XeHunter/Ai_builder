export interface ShopperPromotion {
  id: string;
  name: string;
  description: string | null;
  ends_at: string;
  promo_type: string;
  discount_value: number;
  nearby_only: boolean;
  products: string[];
}

export interface ShopperCoupon {
  id: string;
  code: string;
  status: string;
  promotion: string;
  issued_via: string;
  expires_at: string;
}

export interface OffersResponse {
  promotions: ShopperPromotion[];
  coupons: ShopperCoupon[];
}

export interface Preferences {
  in_app_enabled: boolean;
  email_enabled: boolean;
  sms_enabled: boolean;
  push_enabled: boolean;
  marketing_opt_in: boolean;
  location_consent: boolean;
  location_consent_at: string | null;
  abandoned_list_reminders: boolean;
  cooldown_minutes: number;
}

export type GeofenceAction =
  | { type: "offer"; promotion: string; coupon?: string; notification?: string; outcome?: string }
  | { type: "list_reminder"; list: string; pending_items: number; notification: string };

export interface LocationResult {
  simulated: boolean;
  evaluated_stores: number;
  results: { store: string; distance_m: number; event: "enter" | "exit" | "still_inside"; actions: GeofenceAction[] }[];
}
