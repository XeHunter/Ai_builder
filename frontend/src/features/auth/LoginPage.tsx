import { zodResolver } from "@hookform/resolvers/zod";
import { useQuery } from "@tanstack/react-query";
import { Activity, ArrowRight, LockKeyhole, ShoppingBasket, Store } from "lucide-react";
import * as React from "react";
import { useForm } from "react-hook-form";
import { Link, Navigate, useNavigate, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { z } from "zod";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, Input } from "@/components/ui/input";
import { type DemoPersona, useAuth } from "@/features/auth/auth-context";
import { api, errorMessage } from "@/lib/api";

export const loginSchema = z.object({
  email: z.string().trim().email("Enter a valid email address"),
  password: z.string().min(1, "Password is required"),
});
type LoginForm = z.infer<typeof loginSchema>;

const QUICK_START: { persona: DemoPersona; title: string; subtitle: string; icon: typeof Store; points: string }[] = [
  {
    persona: "customer",
    title: "Enter as Customer",
    subtitle: "Priya, a shopper at FreshMart Andheri",
    icon: ShoppingBasket,
    points: "AI concierge · photo search · smart lists & in-store route · shared list · click & collect",
  },
  {
    persona: "owner",
    title: "Enter as Store Owner",
    subtitle: "FreshMart admin (2 stores, POS + online)",
    icon: Store,
    points: "AI brief · live orders · expiry markdowns · forecasting · pricing · fraud · connectors",
  },
];

/** One-click personas for judges and demos (hidden when the deployment disables demo sign-in). */
function QuickStart({ onDone }: { onDone: (kind: "customer" | "merchant") => void }) {
  const { demoLogin } = useAuth();
  const [busy, setBusy] = React.useState<DemoPersona | null>(null);
  const personas = useQuery({
    queryKey: ["auth", "demo-personas"],
    queryFn: () => api.get<{ enabled: boolean }>("/auth/demo-personas"),
    staleTime: Infinity,
    retry: false,
  });
  if (!personas.data?.enabled) return null;
  const enter = async (persona: DemoPersona) => {
    setBusy(persona);
    try {
      const who = await demoLogin(persona);
      onDone(who.user.account_type);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  return (
    <section aria-labelledby="quick-start" className="flex flex-col gap-3">
      <h2 id="quick-start" className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        One-click demo, no password needed
      </h2>
      {QUICK_START.map((q) => (
        <button
          key={q.persona}
          type="button"
          onClick={() => void enter(q.persona)}
          disabled={busy !== null}
          className="group flex items-start gap-3 rounded-lg border border-border-strong bg-surface p-4 text-left shadow-sm transition hover:border-primary hover:shadow-md disabled:opacity-60"
        >
          <span className="rounded-md bg-primary-soft p-2 text-primary">
            <q.icon className="size-5" aria-hidden />
          </span>
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="flex items-center gap-2 text-base font-semibold">
              {busy === q.persona ? "Signing in…" : q.title}
              <ArrowRight className="size-4 transition group-hover:translate-x-0.5" aria-hidden />
            </span>
            <span className="text-sm text-muted-foreground">{q.subtitle}</span>
            <span className="mt-1 text-xs text-muted-foreground">{q.points}</span>
          </span>
        </button>
      ))}
    </section>
  );
}

export default function LoginPage() {
  const { me, login } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const form = useForm<LoginForm>({ resolver: zodResolver(loginSchema), defaultValues: { email: "", password: "" } });

  if (me) return <Navigate to={me.user.account_type === "merchant" ? "/merchant" : "/shop"} replace />;

  const onSubmit = form.handleSubmit(async (values) => {
    try {
      const who = await login(values.email, values.password);
      const next = params.get("next");
      const home = who.user.account_type === "merchant" ? "/merchant" : "/shop";
      navigate(next && next.startsWith(who.user.account_type === "merchant" ? "/merchant" : "/shop") ? next : home, { replace: true });
    } catch (e) {
      form.setError("root", { message: errorMessage(e) });
    }
  });

  return (
    <div className="flex min-h-full items-center justify-center bg-gradient-to-b from-primary-soft to-background px-4 py-10">
      <div className="grid w-full max-w-4xl gap-6 md:grid-cols-[1.1fr_1fr]">
        <div className="flex flex-col justify-center gap-4">
          <div className="flex items-center gap-2 text-primary">
            <Activity className="size-7" aria-hidden />
            <span className="text-xl font-semibold">OmniPulse AI</span>
          </div>
          <h1 className="text-3xl font-semibold leading-tight">Connect the shopper's journey with your store's operational intelligence.</h1>
          <p className="text-muted-foreground">
            Smart lists and in-store routes for shoppers; expiry, pricing, forecasting, merchandising and fraud workflows for
            store teams — all on one data model.
          </p>
          <QuickStart onDone={(kind) => navigate(kind === "merchant" ? "/merchant" : "/shop", { replace: true })} />
          <Link to="/onboarding" className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline">
            Own a store? Set it up in 5 minutes <ArrowRight className="size-4" aria-hidden />
          </Link>
        </div>
        <Card className="flex flex-col justify-center">
          <CardHeader className="items-center text-center">
            <span className="mb-2 flex size-14 items-center justify-center rounded-full bg-primary-soft text-primary">
              <LockKeyhole className="size-7" aria-hidden />
            </span>
            <CardTitle className="text-xl">Welcome back</CardTitle>
            <CardDescription>Sign in to your OmniPulse account.</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
              <Field label="Email" htmlFor="email" error={form.formState.errors.email?.message}>
                <Input id="email" type="email" autoComplete="username" aria-invalid={!!form.formState.errors.email} {...form.register("email")} />
              </Field>
              <Field label="Password" htmlFor="password" error={form.formState.errors.password?.message}>
                <Input id="password" type="password" autoComplete="current-password" aria-invalid={!!form.formState.errors.password} {...form.register("password")} />
              </Field>
              {form.formState.errors.root && (
                <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">
                  {form.formState.errors.root.message}
                </p>
              )}
              <Button type="submit" size="lg" loading={form.formState.isSubmitting}>
                Sign in
              </Button>
            </form>
            <p className="mt-6 border-t border-border pt-4 text-center text-sm text-muted-foreground">
              New store owner?{" "}
              <Link to="/onboarding" className="font-medium text-primary hover:underline">
                Create your store account
              </Link>
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
