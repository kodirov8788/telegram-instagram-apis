"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Card, CardContent, CardHeader, CardTitle, Input } from "@/components/ui";
import { WorkspaceProvider, useWorkspace } from "@/lib/workspace/context";

/**
 * Onboarding: reached by an authenticated user with zero workspaces
 * (middleware redirect), or manually by anyone wanting to create another.
 * No sidebar/topbar — this isn't inside AppShell, so it mounts its own
 * WorkspaceProvider instance to get apiFetch/refresh/selectWorkspace.
 */
export default function OnboardingPage() {
  return (
    <WorkspaceProvider>
      <OnboardingInner />
    </WorkspaceProvider>
  );
}

function OnboardingInner() {
  const router = useRouter();
  const { workspaces, loading, apiFetch, refresh, selectWorkspace } = useWorkspace();

  const [name, setName] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    setSubmitError(null);
    const trimmed = name.trim();
    if (!trimmed) {
      setNameError("Workspace name is required.");
      return;
    }
    setNameError(null);
    setSubmitting(true);
    try {
      const res = await apiFetch("/api/workspace", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: trimmed }),
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => null);
        setSubmitError(payload?.error ?? `Failed to create workspace (${res.status})`);
        return;
      }
      const payload = await res.json();
      // Refresh workspace discovery, then explicitly select the one just
      // created (it will also auto-select if it's the only one, but this
      // is correct even if the user already had others).
      await refresh();
      if (payload?.workspace?.id) selectWorkspace(payload.workspace.id);
      router.push("/inbox");
      router.refresh();
    } catch {
      setSubmitError("Network error — please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  function handleContinue(workspaceId: string) {
    selectWorkspace(workspaceId);
    router.push("/inbox");
    router.refresh();
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 py-10">
      <div className="flex w-full max-w-sm flex-col gap-6">
        {!loading && workspaces.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle>Your workspaces</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-2">
              {workspaces.map((w) => (
                <Button
                  key={w.id}
                  type="button"
                  variant="secondary"
                  size="md"
                  onClick={() => handleContinue(w.id)}
                  className="justify-between"
                >
                  <span className="truncate">{w.name}</span>
                  <span className="text-xs text-foreground-muted">{w.role}</span>
                </Button>
              ))}
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader>
            <CardTitle>Create a workspace</CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleCreate} className="flex flex-col gap-4" noValidate>
              <Input
                label="Workspace name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                error={nameError ?? undefined}
                disabled={submitting}
                placeholder="Acme Inc."
              />
              {submitError && (
                <p role="alert" className="text-sm text-rose-700">
                  {submitError}
                </p>
              )}
              <Button type="submit" variant="primary" size="md" disabled={submitting}>
                {submitting ? "Creating…" : "Create workspace"}
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
