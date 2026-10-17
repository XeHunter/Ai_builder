import { lazy, Suspense, type ReactNode } from "react";
import { createBrowserRouter, Navigate, useRouteError } from "react-router-dom";

import CustomerLayout from "@/components/layout/CustomerLayout";
import MerchantLayout from "@/components/layout/MerchantLayout";
import { Button } from "@/components/ui/button";
import { EmptyState, Spinner } from "@/components/ui/feedback";
import { useAuth } from "@/features/auth/auth-context";
import LoginPage from "@/features/auth/LoginPage";
import { RequireAuth } from "@/features/auth/RequireAuth";

const page = (loader: () => Promise<{ default: React.ComponentType }>) => {
  const C = lazy(loader);
  return (
    <Suspense fallback={<Spinner className="p-6" label="Loading page" />}>
      <C />
    </Suspense>
  );
};

const guard = (kind: "customer" | "merchant", el: ReactNode, permission?: string) => (
  <RequireAuth kind={kind} permission={permission}>
    {el}
  </RequireAuth>
);

function RootRedirect() {
  const { me, isLoading } = useAuth();
  if (isLoading) return <Spinner className="p-6" />;
  if (!me) return <Navigate to="/login" replace />;
  return <Navigate to={me.user.account_type === "merchant" ? "/merchant" : "/shop"} replace />;
}

function RouteError() {
  const err = useRouteError() as { status?: number; statusText?: string } | Error;
  const notFound = (err as { status?: number })?.status === 404;
  return (
    <div className="p-8">
      <EmptyState
        title={notFound ? "Page not found" : "Something went wrong"}
        description={notFound ? "The page you are looking for does not exist." : String((err as Error)?.message ?? "")}
        action={<Button onClick={() => (window.location.href = "/")}>Go home</Button>}
      />
    </div>
  );
}

export const router = createBrowserRouter([
  { path: "/", element: <RootRedirect />, errorElement: <RouteError /> },
  { path: "/login", element: <LoginPage /> },
  {
    path: "/invite/:token",
    element: guard("customer", page(() => import("@/features/shared-shopping/InviteAcceptPage"))),
  },
  {
    path: "/shop",
    element: guard("customer", <CustomerLayout />),
    errorElement: <RouteError />,
    children: [
      { index: true, element: page(() => import("@/features/shopping-assistant/HomePage")) },
      { path: "products/:productId", element: page(() => import("@/features/shopping-assistant/ProductPage")) },
      { path: "assistant", element: page(() => import("@/features/shopping-assistant/AssistantPage")) },
      { path: "visual", element: page(() => import("@/features/visual-discovery/VisualSearchPage")) },
      { path: "lists", element: page(() => import("@/features/shopping-lists/ListsPage")) },
      { path: "lists/:listId", element: page(() => import("@/features/shopping-lists/ListDetailPage")) },
      { path: "navigate", element: page(() => import("@/features/store-navigation/NavigatePage")) },
      { path: "offers", element: page(() => import("@/features/promotions/OffersPage")) },
      { path: "notifications", element: page(() => import("@/features/notifications/NotificationsPage")) },
    ],
  },
  {
    path: "/merchant",
    element: guard("merchant", <MerchantLayout />),
    errorElement: <RouteError />,
    children: [
      { index: true, element: guard("merchant", page(() => import("@/features/merchant-dashboard/OverviewPage")), "insights.read") },
      { path: "catalog", element: guard("merchant", page(() => import("@/features/inventory/CatalogPage")), "catalog.read") },
      { path: "inventory", element: guard("merchant", page(() => import("@/features/inventory/InventoryPage")), "inventory.read") },
      { path: "inventory/import", element: guard("merchant", page(() => import("@/features/inventory/ImportPage")), "inventory.import") },
      { path: "expiry", element: guard("merchant", page(() => import("@/features/expiry-management/ExpiryPage")), "inventory.read") },
      { path: "forecasting", element: guard("merchant", page(() => import("@/features/demand-forecasting/ForecastingPage")), "forecast.read") },
      { path: "pricing", element: guard("merchant", page(() => import("@/features/dynamic-pricing/PricingPage")), "pricing.read") },
      { path: "layout", element: guard("merchant", page(() => import("@/features/merchandising/LayoutPage")), "layout.read") },
      { path: "merchandising", element: guard("merchant", page(() => import("@/features/merchandising/MerchandisingPage")), "merchandising.read") },
      { path: "cross-selling", element: guard("merchant", page(() => import("@/features/cross-selling/CrossSellingPage")), "affinity.read") },
      { path: "fraud", element: guard("merchant", page(() => import("@/features/fraud-monitoring/FraudPage")), "fraud.read") },
      { path: "insights", element: guard("merchant", page(() => import("@/features/merchant-dashboard/InsightsPage")), "insights.read") },
      { path: "integrations", element: guard("merchant", page(() => import("@/features/merchant-dashboard/IntegrationsPage")), "insights.read") },
      { path: "settings", element: guard("merchant", page(() => import("@/features/merchant-dashboard/SettingsPage")), "insights.read") },
      { path: "notifications", element: page(() => import("@/features/notifications/NotificationsPage")) },
    ],
  },
  { path: "*", element: <RouteError /> },
]);
