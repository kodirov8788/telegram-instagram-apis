"use client";

import { useEffect, useState } from "react";
import { Instagram, Plug, RefreshCw, Send, Settings } from "lucide-react";
import { AppShell, EmptyState, ErrorBanner, ErrorState, SkeletonList } from "@/components/shell";
import { Badge, Button, Card, CardContent, CardHeader, CardTitle } from "@/components/ui";
import { ConfigureConnectionDialog } from "./ConfigureConnectionDialog";
import type { Connection, TestResult } from "./types";
import { useWorkspace } from "@/lib/workspace/context";

function formatDate(value: string | null) {
  if (!value) return "Never";
  try {
    return new Date(value).toLocaleString();
  } catch {
    return value;
  }
}

const channelMeta: Record<Connection["channel"], { label: string; icon: typeof Instagram; tone: "instagram" | "brand" }> = {
  instagram: { label: "Instagram", icon: Instagram, tone: "instagram" },
  telegram: { label: "Telegram", icon: Send, tone: "brand" },
};

export function ConnectionsPageClient() {
  // useWorkspace() must be called from a descendant of the WorkspaceProvider
  // AppShell mounts — this page renders AppShell itself, so the actual body
  // lives in ConnectionsPageInner, rendered as AppShell's child.
  return (
    <AppShell>
      <ConnectionsPageInner />
    </AppShell>
  );
}

function ConnectionsPageInner() {
  const { apiFetch, activeWorkspace, loading: workspaceLoading, error: workspaceError } = useWorkspace();
  const [connections, setConnections] = useState<Connection[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [configuring, setConfiguring] = useState<Connection | null>(null);
  // Per-connection state for the manual "Test connection" action. Never
  // triggered automatically — only from the button's onClick handler below.
  const [testState, setTestState] = useState<Record<string, { pending: boolean; result?: TestResult; error?: string }>>({});

  async function loadConnections() {
    if (!activeWorkspace) return;
    setLoading(true);
    setLoadError(null);
    try {
      const res = await apiFetch("/api/connections");
      if (!res.ok) {
        const payload = await res.json().catch(() => null);
        setLoadError(payload?.error ?? `Failed to load connections (${res.status})`);
        return;
      }
      const payload = await res.json();
      setConnections(payload.connections as Connection[]);
    } catch {
      setLoadError("Network error — please try again.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (activeWorkspace) loadConnections();
    // Intentionally no interval/polling here — connection health is only
    // ever refreshed by an explicit user action (manual reload or Test).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeWorkspace, apiFetch]);

  async function handleTest(connection: Connection) {
    setTestState((prev) => ({ ...prev, [connection.id]: { pending: true } }));
    try {
      const res = await apiFetch(`/api/connections/${connection.id}/test`, { method: "POST" });
      if (!res.ok) {
        const payload = await res.json().catch(() => null);
        setTestState((prev) => ({
          ...prev,
          [connection.id]: { pending: false, error: payload?.error ?? `Test failed (${res.status})` },
        }));
        return;
      }
      const result = (await res.json()) as TestResult;
      setTestState((prev) => ({ ...prev, [connection.id]: { pending: false, result } }));
    } catch {
      setTestState((prev) => ({ ...prev, [connection.id]: { pending: false, error: "Network error — please try again." } }));
    }
  }

  function handleSaved(updated: Connection) {
    setConnections((prev) => (prev ? prev.map((c) => (c.id === updated.id ? updated : c)) : prev));
  }

  if (workspaceLoading) {
    return <SkeletonList rows={3} />;
  }

  if (workspaceError) {
    return <ErrorState message={workspaceError} />;
  }

  if (!activeWorkspace) {
    return (
      <EmptyState
        icon={Plug}
        title="No workspace selected"
        message="Select a workspace to manage its connections."
      />
    );
  }

  return (
    <>
      <div className="flex flex-col gap-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-lg font-semibold text-foreground">Connections</h1>
            <p className="text-sm text-foreground-muted">
              Manage the Instagram and Telegram channels linked to this workspace.
            </p>
          </div>
          <Button variant="secondary" size="sm" onClick={loadConnections} disabled={loading}>
            <RefreshCw className="h-4 w-4" />
            Refresh
          </Button>
        </div>

        {loading && <SkeletonList rows={3} />}

        {!loading && loadError && <ErrorState message={loadError} onRetry={loadConnections} />}

        {!loading && !loadError && connections && connections.length === 0 && (
          <EmptyState
            icon={Plug}
            title="No connections yet"
            message="Instagram and Telegram connections created via onboarding will appear here."
          />
        )}

        {!loading && !loadError && connections && connections.length > 0 && (
          <div className="grid gap-4 sm:grid-cols-2">
            {connections.map((connection) => {
              const meta = channelMeta[connection.channel];
              const Icon = meta.icon;
              const connected = connection.is_active && connection.has_vault_credential;
              const state = testState[connection.id];

              return (
                <Card key={connection.id}>
                  <CardHeader className="flex-row items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="flex h-8 w-8 items-center justify-center rounded-md bg-background-muted">
                        <Icon className="h-4 w-4 text-foreground" />
                      </span>
                      <div>
                        <CardTitle>{meta.label}</CardTitle>
                        <p className="text-xs text-foreground-muted">{connection.account_identifier}</p>
                      </div>
                    </div>
                    <Badge tone={connected ? "success" : "neutral"}>
                      {connected ? "Connected" : "Disconnected"}
                    </Badge>
                  </CardHeader>
                  <CardContent className="flex flex-col gap-3">
                    <dl className="grid grid-cols-2 gap-2 text-xs text-foreground-muted">
                      <div>
                        <dt className="font-medium text-foreground">Credential stored</dt>
                        <dd>{connection.has_vault_credential ? "Yes" : "No"}</dd>
                      </div>
                      <div>
                        <dt className="font-medium text-foreground">Last synced</dt>
                        <dd>{formatDate(connection.last_synced_at)}</dd>
                      </div>
                    </dl>

                    {state?.result && (
                      <p className={`text-sm ${state.result.ok ? "text-emerald-700" : "text-rose-700"}`}>
                        {state.result.ok ? "Connection test passed." : state.result.detail ?? "Connection test failed."}
                      </p>
                    )}
                    {state?.error && <ErrorBanner message={state.error} />}

                    <div className="flex items-center gap-2">
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => setConfiguring(connection)}
                      >
                        <Settings className="h-4 w-4" />
                        {connection.has_vault_credential ? "Reconfigure" : "Connect"}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleTest(connection)}
                        disabled={state?.pending}
                      >
                        {state?.pending ? "Testing…" : "Test connection"}
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </div>

      {configuring && (
        <ConfigureConnectionDialog
          connection={configuring}
          open={!!configuring}
          onClose={() => setConfiguring(null)}
          onSaved={handleSaved}
        />
      )}
    </>
  );
}
