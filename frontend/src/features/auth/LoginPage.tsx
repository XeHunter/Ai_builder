import { zodResolver } from "@hookform/resolvers/zod";
import { Activity, Store, UserRound } from "lucide-react";
import { useForm } from "react-hook-form";
import { Navigate, useNavigate, useSearchParams } from "react-router-dom";
import { z } from "zod";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Callout } from "@/components/ui/feedback";
import { Field, Input } from "@/components/ui/input";
import { useAuth } from "@/features/auth/auth-context";
import { errorMessage } from "@/lib/api";

export const loginSchema = z.object({
  email: z.string().trim().email("Enter a valid email address"),
  password: z.string().min(1, "Password is required"),
});
type LoginForm = z.infer<typeof loginSchema>;

const DEMO_PASSWORD = "Demo@12345";
const DEMO_ACCOUNTS = [
  { email: "priya@demo.omnipulse.ai", label: "Priya — shopper", icon: UserRound },
  { email: "rohan@demo.omnipulse.ai", label: "Rohan — shopper (shared list)", icon: UserRound },
  { email: "admin@freshmart.demo", label: "FreshMart admin", icon: Store },
  { email: "manager.andheri@freshmart.demo", label: "Andheri store manager", icon: Store },
  { email: "analyst@freshmart.demo", label: "FreshMart analyst (read-only)", icon: Store },
];

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
        </div>
        <Card>
          <CardHeader>
            <CardTitle>Sign in</CardTitle>
            <CardDescription>Use your account, or pick a demo account below.</CardDescription>
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
              <Button type="submit" loading={form.formState.isSubmitting}>
                Sign in
              </Button>
            </form>
            <div className="mt-6">
              <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Demo accounts</p>
              <div className="grid gap-1.5">
                {DEMO_ACCOUNTS.map((a) => (
                  <button
                    key={a.email}
                    type="button"
                    onClick={() => {
                      form.setValue("email", a.email);
                      form.setValue("password", DEMO_PASSWORD);
                    }}
                    className="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-left text-sm hover:bg-muted"
                  >
                    <a.icon className="size-4 text-muted-foreground" aria-hidden />
                    <span className="font-medium">{a.label}</span>
                    <span className="ml-auto truncate text-xs text-muted-foreground">{a.email}</span>
                  </button>
                ))}
              </div>
              <Callout tone="simulated" className="mt-3">
                Demo credentials (password <code className="font-mono">{DEMO_PASSWORD}</code>) are for local demo data only.
              </Callout>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
