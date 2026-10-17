import { Activity, Camera, Home, ListChecks, LogOut, MapPinned, MessageSquareText, Tag, UserRound } from "lucide-react";
import { NavLink, Outlet, useNavigate } from "react-router-dom";

import { NotificationBell } from "@/components/layout/NotificationBell";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/input";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/menu";
import { useAuth } from "@/features/auth/auth-context";
import { ShopperStoreProvider, useShopperStore } from "@/hooks/use-stores";
import { cn } from "@/lib/utils";

const NAV = [
  { to: "/shop", label: "Home", icon: Home, end: true },
  { to: "/shop/assistant", label: "Assistant", icon: MessageSquareText },
  { to: "/shop/visual", label: "Photo search", icon: Camera },
  { to: "/shop/lists", label: "Lists", icon: ListChecks },
  { to: "/shop/navigate", label: "Store map", icon: MapPinned },
  { to: "/shop/offers", label: "Offers", icon: Tag },
];

function StorePicker() {
  const { stores, storeId, setStoreId } = useShopperStore();
  return (
    <label className="flex items-center gap-2 text-sm">
      <span className="sr-only">Store</span>
      <Select value={storeId ?? ""} onChange={(e) => setStoreId(e.target.value)} className="h-8 w-48 sm:w-56" aria-label="Select store">
        {stores.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </Select>
    </label>
  );
}

function Shell() {
  const { me, logout } = useAuth();
  const navigate = useNavigate();
  return (
    <div className="flex min-h-full flex-col pb-16 md:pb-0">
      <header className="sticky top-0 z-30 border-b border-border bg-surface/95 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-7xl items-center gap-4 px-4">
          <NavLink to="/shop" className="flex items-center gap-2 font-semibold text-primary">
            <Activity className="size-5" aria-hidden /> <span className="hidden sm:inline">OmniPulse</span>
          </NavLink>
          <nav className="hidden items-center gap-1 md:flex" aria-label="Main">
            {NAV.map((n) => (
              <NavLink
                key={n.to}
                to={n.to}
                end={n.end}
                className={({ isActive }) =>
                  cn("flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground",
                    isActive && "bg-primary-soft text-primary")
                }
              >
                <n.icon className="size-4" aria-hidden />
                {n.label}
              </NavLink>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-2">
            <StorePicker />
            <NotificationBell allLink="/shop/notifications" />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" aria-label="Account menu">
                  <UserRound />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                <DropdownMenuLabel>
                  <span className="block font-medium text-foreground">{me?.user.full_name}</span>
                  {me?.user.email}
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => navigate("/shop/offers")}>Notification & location settings</DropdownMenuItem>
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
        </div>
      </header>
      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6">
        <Outlet />
      </main>
      <nav className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-6 border-t border-border bg-surface md:hidden" aria-label="Main mobile">
        {NAV.map((n) => (
          <NavLink
            key={n.to}
            to={n.to}
            end={n.end}
            className={({ isActive }) => cn("flex flex-col items-center gap-0.5 py-2 text-[11px] text-muted-foreground", isActive && "text-primary")}
          >
            <n.icon className="size-5" aria-hidden />
            {n.label}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}

export default function CustomerLayout() {
  return (
    <ShopperStoreProvider>
      <Shell />
    </ShopperStoreProvider>
  );
}
