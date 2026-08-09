"use client";

import { FormEvent, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button, Card, CardContent, CardHeader, CardTitle, Input } from "@/components/ui";
import { AuthError, signUpWithPassword } from "@/lib/auth/supabase-auth";

const ERROR_MESSAGES: Record<string, string> = {
  email_already_registered: "An account with this email already exists.",
  weak_password: "Password is too weak. Use at least 8 characters.",
  invalid_email: "Enter a valid email address.",
  rate_limited: "Too many attempts. Please wait a moment and try again.",
  unknown: "Something went wrong. Please try again.",
};

function friendlyMessage(err: unknown): string {
  if (err instanceof AuthError) return ERROR_MESSAGES[err.code] ?? err.message;
  return "Something went wrong. Please try again.";
}

export default function SignupPage() {
  const router = useRouter();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [fieldErrors, setFieldErrors] = useState<{ email?: string; password?: string; confirmPassword?: string }>({});
  const [authError, setAuthError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // Set when Supabase's "Confirm email" setting is on: signUp succeeds with
  // no error, but returns no session until the user clicks the emailed
  // confirmation link. This is a production/Supabase-dashboard configuration
  // decision, not something to work around client-side.
  const [awaitingConfirmation, setAwaitingConfirmation] = useState(false);

  function validate(): boolean {
    const errors: { email?: string; password?: string; confirmPassword?: string } = {};
    if (!email.trim()) errors.email = "Email is required.";
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) errors.email = "Enter a valid email address.";
    if (!password) errors.password = "Password is required.";
    else if (password.length < 8) errors.password = "Password must be at least 8 characters.";
    if (confirmPassword !== password) errors.confirmPassword = "Passwords don't match.";
    setFieldErrors(errors);
    return Object.keys(errors).length === 0;
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setAuthError(null);
    if (!validate()) return;

    setSubmitting(true);
    try {
      const result = await signUpWithPassword(email.trim(), password);
      if (!result.session) {
        // Email confirmation is required before a session exists.
        setAwaitingConfirmation(true);
        return;
      }
      router.push("/onboarding");
      router.refresh();
    } catch (err) {
      setAuthError(friendlyMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  if (awaitingConfirmation) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-4">
        <Card className="w-full max-w-sm">
          <CardHeader>
            <CardTitle>Check your email</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-foreground-muted">
              We sent a confirmation link to <span className="font-medium text-foreground">{email}</span>.
              Click it, then{" "}
              <Link href="/login" className="font-medium text-brand-600 underline underline-offset-2 hover:text-brand-700">
                log in
              </Link>
              .
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Sign up</CardTitle>
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
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              error={fieldErrors.password}
              disabled={submitting}
            />
            <Input
              label="Confirm password"
              type="password"
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              error={fieldErrors.confirmPassword}
              disabled={submitting}
            />

            {authError && (
              <p role="alert" className="text-sm text-rose-700">
                {authError}
              </p>
            )}

            <Button type="submit" variant="primary" size="md" disabled={submitting}>
              {submitting ? "Signing up…" : "Sign up"}
            </Button>

            <p className="text-center text-sm text-foreground-muted">
              Already have an account?{" "}
              <Link href="/login" className="font-medium text-brand-600 underline underline-offset-2 hover:text-brand-700">
                Log in
              </Link>
            </p>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
