import {
  Activity,
  BarChart3,
  Boxes,
  Cable,
  CalendarClock,
  FlaskConical,
  Grid3x3,
  LayoutDashboard,
  LogOut,
  Map,
  Menu,
  Network,
  Package,
  Plug,
  Rocket,
  Settings,
  ShieldAlert,
  TrendingUp,
  Users,
  WandSparkles,
  X,
  type LucideIcon,
} from "lucide-react";
import * as React from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";

import { NotificationBell } from "@/components/layout/NotificationBell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/input";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/menu";
import { useAuth } from "@/features/auth/auth-context";
import { MerchantStoreProvider, useMerchantStore } from "@/hooks/use-stores";
import { cn, titleCase } from "@/lib/utils";

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  permission: string;
  end?: boolean;
}

const SECTIONS: { title: string; items: NavItem[] }[] = [
  {
    title: "Operations",
    items: [
      { to: "/merchant", label: "Overview", icon: LayoutDashboard, permission: "insights.read", end: true },
      { to: "/merchant/catalog", label: "Product catalog", icon: Package, permission: "catalog.read" },
      { to: "/merchant/inventory", label: "Inventory", icon: Boxes, permission: "inventory.read" },
      { to: "/merchant/expiry", label: "Expiry management", icon: CalendarClock, permission: "inventory.read" },
      { to: "/merchant/channels", label: "Channels & orders", icon: Cable, permission: "insights.read" },
    ],
  },
  {
    title: "Intelligence",
    items: [
      { to: "/merchant/forecasting", label: "Demand forecasting", icon: TrendingUp, permission: "forecast.read" },
      { to: "/merchant/pricing", label: "Pricing & promotions", icon: WandSparkles, permission: "pricing.read" },
      { to: "/merchant/layout", label: "Store layout", icon: Map, permission: "layout.read" },
      { to: "/merchant/merchandising", label: "Merchandising", icon: Grid3x3, permission: "merchandising.read" },
      { to: "/merchant/cross-selling", label: "Cross-selling", icon: Network, permission: "affinity.read" },
    ],
  },
  {
    title: "Risk & customers",
    items: [
      { to: "/merchant/fraud", label: "Fraud monitoring", icon: ShieldAlert, permission: "fraud.read" },
      { to: "/merchant/insights", label: "Shopping insights", icon: Users, permission: "insights.read" },
    ],
  },
  {
    title: "Administration",
    items: [
      { to: "/merchant/setup", label: "Store setup", icon: Rocket, permission: "insights.read" },
      { to: "/merchant/integrations", label: "Integrations", icon: Plug, permission: "insights.read" },
      { to: "/merchant/settings", label: "Settings & audit", icon: Settings, permission: "insights.read" },
    ],
  },
];

function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const { can } = useAuth();
  return (
    <nav className="flex flex-col gap-5 px-3 py-4" aria-label="Merchant">
      {SECTIONS.map((section) => (
        <div key={section.title}>
          <p className="mb-1 px-3 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{section.title}</p>
          <ul className="flex flex-col gap-0.5">
            {section.items.filter((i) => can(i.permission)).map((i) => (
              <li key={i.to}>
                <NavLink
                  to={i.to}
                  end={i.end}
                  onClick={onNavigate}
                  className={({ isActive }) =>
                    cn("flex items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground",
                      isActive && "bg-primary-soft text-primary")
                  }
                >
                  <i.icon className="size-4" aria-hidden />
                  {i.label}
                </NavLink>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );
}

function StoreFilter() {
  const { stores, storeId, setStoreId } = useMerchantStore();
  return (
    <Select value={storeId ?? ""} onChange={(e) => setStoreId(e.target.value || null)} className="h-8 w-44 sm:w-56" aria-label="Store filter">
      {stores.length > 1 && <option value="">All stores</option>}
      {stores.map((s) => (
        <option key={s.id} value={s.id}>
          {s.name}
        </option>
      ))}
    </Select>
  );
}

function Shell() {
  const { me, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [open, setOpen] = React.useState(false);
  React.useEffect(() => setOpen(false), [location.pathname]);
  return (
    <div className="flex min-h-full">
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 overflow-y-auto border-r border-border bg-surface lg:block">
        <div className="flex h-14 items-center gap-2 border-b border-border px-5 font-semibold text-primary">
          <Activity className="size-5" aria-hidden /> OmniPulse
          <span className="text-xs font-normal text-muted-foreground">for retailers</span>
        </div>
        <Sidebar />
      </aside>
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-black/30" onClick={() => setOpen(false)} aria-hidden />
          <aside className="absolute inset-y-0 left-0 w-72 overflow-y-auto bg-surface shadow-xl">
            <div className="flex h-14 items-center justify-between border-b border-border px-4">
              <span className="font-semibold text-primary">OmniPulse</span>
              <Button variant="ghost" size="icon" onClick={() => setOpen(false)} aria-label="Close menu">
                <X />
              </Button>
            </div>
            <Sidebar onNavigate={() => setOpen(false)} />
          </aside>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-border bg-surface/95 px-4 backdrop-blur">
          <Button variant="ghost" size="icon" className="lg:hidden" onClick={() => setOpen(true)} aria-label="Open menu">
            <Menu />
          </Button>
          <div className="hidden min-w-0 text-sm sm:block">
            <span className="font-medium">{me?.merchant?.merchant_name}</span>
            <span className="text-muted-foreground"> · {titleCase(me?.merchant?.role ?? "")}</span>
          </div>
          <Badge variant="accent" className="hidden md:inline-flex">
            <FlaskConical className="size-3" aria-hidden /> Demo data
          </Badge>
          <div className="ml-auto flex items-center gap-2">
            <StoreFilter />
            <NotificationBell allLink="/merchant/notifications" />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" aria-label="Account menu">
                  <BarChart3 className="sm:hidden" />
                  <span className="hidden max-w-36 truncate sm:inline">{me?.user.full_name}</span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                <DropdownMenuLabel>{me?.user.email}</DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => navigate("/merchant/settings")}>
                  <Settings /> Settings & audit
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={async () => {
                    await logout();
                    navigate("/login");
                  }}
                >
                  <LogOut /> Sign out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </header>
        <main className="mx-auto w-full max-w-[1400px] flex-1 px-4 py-6 lg:px-8">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

export default function MerchantLayout() {
  return (
    <MerchantStoreProvider>
      <Shell />
    </MerchantStoreProvider>
  );
}
