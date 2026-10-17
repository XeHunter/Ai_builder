/**
 * Firebase client: Firestore real-time subscriptions authorised by a Firebase Auth custom token.
 *
 * The OmniPulse API stays the source of truth and the only writer of business data. On deployments
 * served by Firebase Hosting, the API mirrors shared-list events and the merchant live feed into
 * Firestore, and the browser listens there (Hosting cannot proxy WebSockets to Cloud Run).
 *
 * Configuration is discovered at runtime:
 *  1. GET /api/v1/realtime/config  -> {"transport": "firestore" | "websocket"}
 *  2. GET /__/firebase/init.json   -> web app config, served automatically by Firebase Hosting
 *     (or VITE_FIREBASE_CONFIG as a JSON string for local development against a real project)
 *  3. POST /api/v1/realtime/token  -> custom token (uid = OmniPulse user id, merchant claim for staff)
 * Anything missing means "no Firestore" and callers fall back to WebSocket / polling.
 */
import type { FirebaseApp, FirebaseOptions } from "firebase/app";
import type { Firestore } from "firebase/firestore";

import { api } from "@/lib/api";

export interface FirestoreSession {
  db: Firestore;
  uid: string;
}

let sessionPromise: Promise<FirestoreSession | null> | null = null;
let sessionUser: string | null = null;
let app: FirebaseApp | null = null;

async function webConfig(): Promise<FirebaseOptions | null> {
  const fromEnv = import.meta.env.VITE_FIREBASE_CONFIG as string | undefined;
  if (fromEnv) {
    try {
      return JSON.parse(fromEnv) as FirebaseOptions;
    } catch {
      console.warn("VITE_FIREBASE_CONFIG is not valid JSON");
    }
  }
  try {
    const res = await fetch("/__/firebase/init.json", { credentials: "omit" });
    if (!res.ok || !(res.headers.get("content-type") ?? "").includes("json")) return null;
    return (await res.json()) as FirebaseOptions;
  } catch {
    return null;
  }
}

async function connect(): Promise<FirestoreSession | null> {
  const { transport } = await api.get<{ transport: string }>("/realtime/config");
  if (transport !== "firestore") return null;
  const cfg = await webConfig();
  if (!cfg?.projectId) return null;
  const [{ initializeApp, getApps }, { getAuth, signInWithCustomToken }, { getFirestore }] = await Promise.all([
    import("firebase/app"),
    import("firebase/auth"),
    import("firebase/firestore"),
  ]);
  app = getApps()[0] ?? initializeApp(cfg);
  const { token, uid } = await api.post<{ token: string; uid: string }>("/realtime/token");
  await signInWithCustomToken(getAuth(app), token);
  return { db: getFirestore(app), uid };
}

/** Firestore session for the signed-in user, or null when this deployment uses WebSocket / polling. */
export function getFirestoreSession(userId: string): Promise<FirestoreSession | null> {
  if (sessionPromise && sessionUser === userId) return sessionPromise;
  sessionUser = userId;
  sessionPromise = connect().catch((e) => {
    console.warn("Firestore real-time unavailable, falling back:", e);
    return null;
  });
  return sessionPromise;
}

/** Called on logout so the next user gets a fresh Firebase identity. */
export async function signOutFirebase(): Promise<void> {
  sessionPromise = null;
  sessionUser = null;
  if (!app) return;
  const { getAuth, signOut } = await import("firebase/auth");
  await signOut(getAuth(app)).catch(() => undefined);
}
