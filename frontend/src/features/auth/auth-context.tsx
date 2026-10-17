import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";

import { api, ApiError } from "@/lib/api";
import { signOutFirebase } from "@/lib/firebase";
import type { Me } from "@/types/api";

interface AuthValue {
  me: Me | null;
  isLoading: boolean;
  login: (email: string, password: string) => Promise<Me>;
  /** One-click demo persona (customer / owner ...), only on demo deployments. */
  demoLogin: (persona: DemoPersona) => Promise<Me>;
  /** Adopt a session returned by another endpoint (e.g. store-owner sign-up). */
  adopt: (data: Me) => void;
  logout: () => Promise<void>;
  can: (permission: string) => boolean;
  refresh: () => void;
}

export type DemoPersona = "customer" | "customer2" | "owner" | "manager" | "analyst";

const AuthContext = React.createContext<AuthValue | null>(null);

export const ME_KEY = ["auth", "me"] as const;

async function fetchMe(): Promise<Me | null> {
  try {
    return await api.get<Me>("/auth/me");
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) return null;
    throw e;
  }
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const qc = useQueryClient();
  const meQuery = useQuery({ queryKey: ME_KEY, queryFn: fetchMe, staleTime: 5 * 60_000, retry: false });

  const loginMut = useMutation({
    mutationFn: ({ email, password }: { email: string; password: string }) => api.post<Me>("/auth/login", { email, password }),
    onSuccess: (data) => {
      qc.clear();
      qc.setQueryData(ME_KEY, { user: data.user, merchant: data.merchant });
    },
  });

  const adopt = React.useCallback(
    (data: Me) => {
      // Drop the previous user's cached data but keep the session query itself, so mounted
      // observers (route guards) see the new identity immediately.
      qc.removeQueries({ predicate: (q) => q.queryKey[0] !== ME_KEY[0] });
      qc.setQueryData(ME_KEY, { user: data.user, merchant: data.merchant });
    },
    [qc],
  );

  const value = React.useMemo<AuthValue>(
    () => ({
      me: meQuery.data ?? null,
      isLoading: meQuery.isLoading,
      login: async (email, password) => {
        const data = await loginMut.mutateAsync({ email, password });
        return { user: data.user, merchant: data.merchant };
      },
      demoLogin: async (persona) => {
        await signOutFirebase();
        const data = await api.post<Me>("/auth/demo-login", { persona });
        adopt(data);
        return { user: data.user, merchant: data.merchant };
      },
      adopt,
      logout: async () => {
        try {
          await api.post("/auth/logout");
          await signOutFirebase();
        } finally {
          qc.clear();
          qc.setQueryData(ME_KEY, null);
        }
      },
      can: (permission) => Boolean(meQuery.data?.merchant?.permissions.includes(permission)),
      refresh: () => void qc.invalidateQueries({ queryKey: ME_KEY }),
    }),
    [meQuery.data, meQuery.isLoading, loginMut, qc, adopt],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const ctx = React.useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
