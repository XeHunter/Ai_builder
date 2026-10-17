import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";

import { api, ApiError } from "@/lib/api";
import type { Me } from "@/types/api";

interface AuthValue {
  me: Me | null;
  isLoading: boolean;
  login: (email: string, password: string) => Promise<Me>;
  logout: () => Promise<void>;
  can: (permission: string) => boolean;
  refresh: () => void;
}

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

  const value = React.useMemo<AuthValue>(
    () => ({
      me: meQuery.data ?? null,
      isLoading: meQuery.isLoading,
      login: async (email, password) => {
        const data = await loginMut.mutateAsync({ email, password });
        return { user: data.user, merchant: data.merchant };
      },
      logout: async () => {
        try {
          await api.post("/auth/logout");
        } finally {
          qc.clear();
          qc.setQueryData(ME_KEY, null);
        }
      },
      can: (permission) => Boolean(meQuery.data?.merchant?.permissions.includes(permission)),
      refresh: () => void qc.invalidateQueries({ queryKey: ME_KEY }),
    }),
    [meQuery.data, meQuery.isLoading, loginMut, qc],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const ctx = React.useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
