"use client";

import { FormEvent, useEffect, useState } from "react";
import { Button, Card, CardContent, CardHeader, CardTitle, Input } from "@/components/ui";
import { ErrorBanner } from "@/components/shell";
import { SkeletonText } from "@/components/shell";
import type { Workspace } from "./types";
import { useWorkspace } from "@/lib/workspace/context";

/**
 * Workspace profile: name / industry / timezone via GET+PUT /api/workspace.
 */
export function WorkspaceProfileSection() {
  const { apiFetch, activeWorkspace } = useWorkspace();
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const [name, setName] = useState("");
  const [industry, setIndustry] = useState("");
  const [timeZone, setTimeZone] = useState("");

  async function loadWorkspace() {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await apiFetch("/api/workspace");
      if (!res.ok) {
        const payload = await res.json().catch(() => null);
        setLoadError(payload?.error ?? `Failed to load workspace (${res.status})`);
        return;
      }
      const payload = await res.json();
      const ws = payload.workspace as Workspace;
      setWorkspace(ws);
      setName(ws.name ?? "");
      setIndustry(ws.industry ?? "");
      setTimeZone(ws.time_zone ?? ws.timeZone ?? "");
    } catch {
      setLoadError("Network error — please try again.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    // On a hard page load, WorkspaceProvider resolves activeWorkspaceId
    // asynchronously (localStorage read + GET /api/workspaces). If this
    // effect fires before that resolves, apiFetch has no x-workspace-id
    // header yet and the request 400s with no way to recover (this
    // component previously had no retry affordance at all). Wait for a
    // real activeWorkspace before fetching; the effect re-runs once it
    // appears, since apiFetch's identity changes with it.
    if (!activeWorkspace) return;
    loadWorkspace();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiFetch, activeWorkspace]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setSaveError(null);
    setSaved(false);
    try {
      const res = await apiFetch("/api/workspace", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, industry, timeZone }),
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => null);
        setSaveError(payload?.error ?? `Failed to save (${res.status})`);
        return;
      }
      const payload = await res.json();
      setWorkspace(payload.workspace);
      setSaved(true);
    } catch {
      setSaveError("Network error — please try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Workspace profile</CardTitle>
      </CardHeader>
      <CardContent>
        {loading && <SkeletonText lines={4} />}
        {!loading && loadError && <ErrorBanner message={loadError} onRetry={loadWorkspace} />}
        {!loading && !loadError && (
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <Input label="Workspace name" value={name} onChange={(e) => setName(e.target.value)} required />
            <Input label="Industry" value={industry} onChange={(e) => setIndustry(e.target.value)} />
            <Input
              label="Time zone"
              value={timeZone}
              onChange={(e) => setTimeZone(e.target.value)}
              placeholder="Asia/Tashkent"
            />
            {saveError && <ErrorBanner message={saveError} />}
            {saved && <p className="text-sm text-emerald-700">Saved.</p>}
            <div>
              <Button type="submit" variant="primary" size="sm" disabled={saving}>
                {saving ? "Saving…" : "Save changes"}
              </Button>
            </div>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
