"use client";

import { FormEvent, Suspense, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Button, Card, CardContent, CardHeader, CardTitle, Input } from "@/components/ui";
import { AuthError, signInWithPassword } from "@/lib/auth/supabase-auth";

const ERROR_MESSAGES: Record<string, string> = {
  invalid_credentials: "Incorrect email or password.",
  email_not_confirmed: "Please confirm your email address before logging in.",
  rate_limited: "Too many attempts. Please wait a moment and try again.",
  unknown: "Something went wrong. Please try again.",
};

function friendlyMessage(err: unknown): string {
  if (err instanceof AuthError) return ERROR_MESSAGES[err.code] ?? err.message;
  return "Something went wrong. Please try again.";
}

function LoginFormInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const redirectTo = searchParams.get("redirect") || "/inbox";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fieldErrors, setFieldErrors] = useState<{ email?: string; password?: string }>({});
  const [authError, setAuthError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function validate(): boolean {
    const errors: { email?: string; password?: string } = {};
    if (!email.trim()) errors.email = "Email is required.";
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) errors.email = "Enter a valid email address.";
    if (!password) errors.password = "Password is required.";
    setFieldErrors(errors);
    return Object.keys(errors).length === 0;
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setAuthError(null);
    if (!validate()) return;

    setSubmitting(true);
    try {
      await signInWithPassword(email.trim(), password);
      // Middleware handles the actual destination (onboarding vs. app) on
      // the next navigation — this just moves off the login page.
      router.push(redirectTo);
      router.refresh();
    } catch (err) {
      setAuthError(friendlyMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Log in</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="flex flex-col gap-4" noValidate>
            <Input
              label="Email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              error={fieldErrors.email}
              disabled={submitting}
            />
            <Input
              label="Password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              error={fieldErrors.password}
              disabled={submitting}
            />

            {authError && (
              <p role="alert" className="text-sm text-rose-700">
                {authError}
              </p>
            )}

            <Button type="submit" variant="primary" size="md" disabled={submitting}>
              {submitting ? "Logging in…" : "Log in"}
            </Button>

            <p className="text-center text-sm text-foreground-muted">
              Don&apos;t have an account?{" "}
              <Link href="/signup" className="font-medium text-brand-600 underline underline-offset-2 hover:text-brand-700">
                Sign up
              </Link>
            </p>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

export function LoginPageClient() {
  // useSearchParams() requires a Suspense boundary in the App Router.
  return (
    <Suspense fallback={null}>
      <LoginFormInner />
    </Suspense>
  );
}
