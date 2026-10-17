import { ShieldAlert } from "lucide-react";
import { Navigate, useLocation } from "react-router-dom";

import { Button } from "@/components/ui/button";
import { EmptyState, Spinner } from "@/components/ui/feedback";
import { useAuth } from "@/features/auth/auth-context";

interface Props {
  kind: "customer" | "merchant";
  permission?: string;
  children: React.ReactNode;
}

/** Client-side route guard. The server enforces the same rules on every request. */
export function RequireAuth({ kind, permission, children }: Props) {
  const { me, isLoading } = useAuth();
  const location = useLocation();
  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner label="Checking your session" />
      </div>
    );
  }
  if (!me) return <Navigate to={`/login?next=${encodeURIComponent(location.pathname + location.search)}`} replace />;
  if (me.user.account_type !== kind) {
    return <Navigate to={me.user.account_type === "merchant" ? "/merchant" : "/shop"} replace />;
  }
  if (permission && !me.merchant?.permissions.includes(permission)) {
    return <PermissionDenied permission={permission} />;
  }
  return <>{children}</>;
}

export function PermissionDenied({ permission }: { permission: string }) {
  return (
    <div className="p-6">
      <EmptyState
        icon={ShieldAlert}
        title="You don't have access to this page"
        description={`Your role does not include the "${permission}" permission. Ask a merchant administrator for access.`}
        action={
          <Button variant="outline" onClick={() => window.history.back()}>
            Go back
          </Button>
        }
      />
    </div>
  );
}
