import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { Toaster } from "sonner";

import { TooltipProvider } from "@/components/ui/menu";
import { AuthProvider } from "@/features/auth/auth-context";
import { ApiError } from "@/lib/api";

export function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        refetchOnWindowFocus: false,
        // Don't retry client errors (validation, auth, not found); retry transient failures once.
        retry: (count, err) => !(err instanceof ApiError && err.status >= 400 && err.status < 500) && count < 1,
      },
    },
  });
}

export function AppProviders({ children, client }: { children: React.ReactNode; client?: QueryClient }) {
  const [qc] = React.useState(() => client ?? makeQueryClient());
  return (
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <AuthProvider>{children}</AuthProvider>
      </TooltipProvider>
      <Toaster position="top-right" richColors closeButton />
    </QueryClientProvider>
  );
}
