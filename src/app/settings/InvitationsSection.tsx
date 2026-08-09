"use client";

import { FormEvent, useState } from "react";
import { Button, Card, CardContent, CardHeader, CardTitle, Input } from "@/components/ui";
import { ErrorBanner } from "@/components/shell";
import { ASSIGNABLE_ROLES, type Role } from "./types";
import { useWorkspace } from "@/lib/workspace/context";

/**
 * Invitations: create-only. `POST /api/workspace/invitations` exists and is
 * wired below; there is no `GET` route to list pending invitations
 * (checked `src/app/api/workspace/invitations/route.ts` — only POST is
 * exported), so a pending-invitations list is a documented gap rather than
 * a client-side guess at a shape the API doesn't provide.
 */
export function InvitationsSection() {
  const { apiFetch } = useWorkspace();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("sales_representative");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastInvited, setLastInvited] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    setLastInvited(null);
    try {
      const res = await apiFetch("/api/workspace/invitations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, role }),
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => null);
        const message =
          res.status === 403
            ? "You don't have permission to invite members."
            : payload?.error ?? `Failed to send invitation (${res.status})`;
        setError(message);
        return;
      }
      const payload = await res.json();
      setLastInvited(payload.invitation.email);
      setEmail("");
    } catch {
      setError("Network error — please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Invitations</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <form onSubmit={handleSubmit} className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="flex-1">
            <Input
              label="Email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-foreground">Role</label>
            <select
              value={role}
              onChange={(e) => setRole(e.target.value as Role)}
              className="h-9 rounded-md border border-border-strong bg-background px-3 text-sm text-foreground"
            >
              {ASSIGNABLE_ROLES.map((r) => (
                <option key={r} value={r}>
                  {r.replace(/_/g, " ")}
                </option>
              ))}
            </select>
          </div>
          <Button type="submit" variant="primary" size="sm" disabled={submitting}>
            {submitting ? "Sending…" : "Send invitation"}
          </Button>
        </form>

        {error && <ErrorBanner message={error} />}
        {lastInvited && (
          <p className="text-sm text-emerald-700">Invitation sent to {lastInvited}.</p>
        )}

        <p className="text-xs text-foreground-muted">
          Pending invitations aren&apos;t listed here yet — the API doesn&apos;t currently expose a
          list endpoint for them.
        </p>
      </CardContent>
    </Card>
  );
}
