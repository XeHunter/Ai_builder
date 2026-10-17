import { zodResolver } from "@hookform/resolvers/zod";
import { Activity, CheckCircle2 } from "lucide-react";
import { useForm } from "react-hook-form";
import { Link, Navigate, useNavigate } from "react-router-dom";
import { z } from "zod";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, Input } from "@/components/ui/input";
import { useAuth } from "@/features/auth/auth-context";
import { api, ApiError, errorMessage } from "@/lib/api";
import type { Me } from "@/types/api";

import { SETUP_STEPS } from "./onboarding-api";

export const signupSchema = z.object({
  business_name: z.string().trim().min(2, "Enter your business name").max(120),
  full_name: z.string().trim().min(2, "Enter your name").max(120),
  email: z.string().trim().email("Enter a valid email address"),
  password: z.string().min(8, "Use at least 8 characters").max(128),
});
type SignupForm = z.infer<typeof signupSchema>;

export default function SignupPage() {
  const { me, adopt } = useAuth();
  const navigate = useNavigate();
  const form = useForm<SignupForm>({ resolver: zodResolver(signupSchema), defaultValues: { business_name: "", full_name: "", email: "", password: "" } });
  const errors = form.formState.errors;

  if (me?.user.account_type === "merchant") return <Navigate to="/merchant/setup" replace />;

  const onSubmit = form.handleSubmit(async (values) => {
    try {
      const data = await api.post<Me & { access_token: string }>("/onboarding/merchant", values);
      adopt(data);
      navigate("/merchant/setup", { replace: true });
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        form.setError("email", { message: "An account with this email already exists. Sign in instead." });
      } else {
        form.setError("root", { message: errorMessage(e) });
      }
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
          <h1 className="text-3xl font-semibold leading-tight">Set up your store in 5 minutes.</h1>
          <p className="text-muted-foreground">
            Create your account, then a guided setup takes you from an empty store to live dashboards, shopper navigation and AI insights.
          </p>
          <ol className="flex flex-col gap-2.5" aria-label="Setup steps">
            {SETUP_STEPS.map((s, i) => (
              <li key={s.key} className="flex gap-3">
                <span className="tabular flex size-6 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">{i + 1}</span>
                <span className="text-sm">
                  <span className="font-medium">{s.title}</span>
                  <span className="text-muted-foreground"> — {s.blurb}</span>
                </span>
              </li>
            ))}
          </ol>
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <CheckCircle2 className="size-4 text-success" aria-hidden /> Starter catalog and sample sales included, so you can try everything right away.
          </p>
        </div>
        <Card>
          <CardHeader>
            <CardTitle>Create your store account</CardTitle>
            <CardDescription>You will be the owner (admin) of this business.</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
              <Field label="Business name" htmlFor="business_name" error={errors.business_name?.message}>
                <Input id="business_name" autoComplete="organization" placeholder="e.g. Sharma Fresh Mart" aria-invalid={!!errors.business_name} {...form.register("business_name")} />
              </Field>
              <Field label="Your name" htmlFor="full_name" error={errors.full_name?.message}>
                <Input id="full_name" autoComplete="name" aria-invalid={!!errors.full_name} {...form.register("full_name")} />
              </Field>
              <Field label="Email" htmlFor="email" error={errors.email?.message}>
                <Input id="email" type="email" autoComplete="email" aria-invalid={!!errors.email} {...form.register("email")} />
              </Field>
              <Field label="Password" htmlFor="password" error={errors.password?.message} hint="At least 8 characters.">
                <Input id="password" type="password" autoComplete="new-password" aria-invalid={!!errors.password} {...form.register("password")} />
              </Field>
              {errors.root && (
                <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">
                  {errors.root.message}
                </p>
              )}
              <Button type="submit" loading={form.formState.isSubmitting}>
                Create account & start setup
              </Button>
            </form>
            <p className="mt-4 text-center text-sm text-muted-foreground">
              Already have an account?{" "}
              <Link to="/login" className="font-medium text-primary hover:underline">
                Sign in
              </Link>
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
