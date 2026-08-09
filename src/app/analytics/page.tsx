'use client';

import React, { useCallback, useEffect, useState } from 'react';
import {
  BarChart3,
  Clock,
  CheckCircle2,
  AlertTriangle,
  Download,
  Users,
  type LucideIcon,
} from 'lucide-react';
import { Card, CardHeader, CardTitle, CardContent, Badge, type BadgeTone } from '@/components/ui';
import { AppShell, Skeleton, ErrorState, EmptyState } from '@/components/shell';
import { useWorkspace } from '@/lib/workspace/context';

type StatusCounts = Record<string, number>;

interface MetricsResponse {
  inbound: StatusCounts;
  outbound: StatusCounts;
}

interface HealthQueue {
  queue: string;
  backlogCount: number;
  oldestUnclaimedAgeMs: number | null;
}

interface HealthResponse {
  status: string;
  inbound: HealthQueue;
  outbound: HealthQueue;
}

interface LeadsResponse {
  leads: unknown[];
}

function formatAgeMs(ms: number | null): string {
  if (ms === null) return 'none waiting';
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h`;
}

function backlogTone(backlogCount: number): BadgeTone {
  if (backlogCount === 0) return 'success';
  if (backlogCount < 10) return 'warning';
  return 'error';
}

interface KpiCardData {
  label: string;
  value: string;
  helper: string;
  icon: LucideIcon;
  tone: BadgeTone;
}

export default function AnalyticsPage() {
  // useWorkspace() must be called from a descendant of the WorkspaceProvider
  // AppShell mounts — this page renders AppShell itself, so the actual body
  // lives in AnalyticsPageInner, rendered as AppShell's child.
  return (
    <AppShell>
      <AnalyticsPageInner />
    </AppShell>
  );
}

function AnalyticsPageInner() {
  const { apiFetch, activeWorkspace, loading: workspaceLoading, error: workspaceError } = useWorkspace();
  const [metrics, setMetrics] = useState<MetricsResponse | null>(null);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [leadCount, setLeadCount] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!activeWorkspace) return;
    setLoading(true);
    setError(null);
    try {
      const [metricsRes, healthRes, leadsRes] = await Promise.all([
        apiFetch('/api/observability/metrics'),
        apiFetch('/api/observability/health'),
        apiFetch('/api/leads'),
      ]);

      if (!metricsRes.ok) throw new Error(`Failed to load metrics (${metricsRes.status})`);
      if (!healthRes.ok) throw new Error(`Failed to load health (${healthRes.status})`);

      const metricsData: MetricsResponse = await metricsRes.json();
      const healthData: HealthResponse = await healthRes.json();

      setMetrics(metricsData);
      setHealth(healthData);

      if (leadsRes.ok) {
        const leadsData: LeadsResponse = await leadsRes.json();
        setLeadCount(Array.isArray(leadsData.leads) ? leadsData.leads.length : null);
      } else {
        setLeadCount(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load analytics data.');
    } finally {
      setLoading(false);
    }
  }, [apiFetch, activeWorkspace]);

  useEffect(() => {
    if (activeWorkspace) load();
  }, [load, activeWorkspace]);

  const totalInbound = metrics
    ? Object.values(metrics.inbound).reduce((sum, n) => sum + n, 0)
    : 0;
  const totalOutbound = metrics
    ? Object.values(metrics.outbound).reduce((sum, n) => sum + n, 0)
    : 0;
  const totalEvents = totalInbound + totalOutbound;

  const processedInbound = metrics?.inbound.processed ?? 0;
  const resolutionRate =
    totalInbound > 0 ? Math.round((processedInbound / totalInbound) * 100) : 0;

  const failedCount = metrics
    ? (metrics.inbound.permanent_failed ?? 0) + (metrics.outbound.permanent_failed ?? 0)
    : 0;

  const kpis: KpiCardData[] = [
    {
      label: 'Total Events',
      value: totalEvents.toLocaleString(),
      helper: `${totalInbound.toLocaleString()} inbound / ${totalOutbound.toLocaleString()} outbound`,
      icon: BarChart3,
      tone: 'brand',
    },
    {
      label: 'Inbound Queue Backlog',
      value: (health?.inbound.backlogCount ?? 0).toLocaleString(),
      helper: `oldest waiting: ${formatAgeMs(health?.inbound.oldestUnclaimedAgeMs ?? null)}`,
      icon: Clock,
      tone: backlogTone(health?.inbound.backlogCount ?? 0),
    },
    {
      label: 'Inbound Processed Rate',
      value: `${resolutionRate}%`,
      helper: `${processedInbound.toLocaleString()} of ${totalInbound.toLocaleString()} processed`,
      icon: CheckCircle2,
      tone: 'success',
    },
    {
      label: 'Permanent Failures',
      value: failedCount.toLocaleString(),
      helper: 'inbound + outbound combined',
      icon: AlertTriangle,
      tone: failedCount > 0 ? 'error' : 'success',
    },
  ];

  if (leadCount !== null) {
    kpis.push({
      label: 'Total Leads',
      value: leadCount.toLocaleString(),
      helper: 'across all statuses',
      icon: Users,
      tone: 'secondary',
    });
  }

  if (workspaceLoading) {
    return (
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        {Array.from({ length: 4 }).map((_, idx) => (
          <Card key={idx}>
            <CardContent className="space-y-3 py-6">
              <Skeleton className="h-3 w-24" />
              <Skeleton className="h-8 w-16" />
            </CardContent>
          </Card>
        ))}
      </div>
    );
  }

  if (workspaceError) {
    return <ErrorState message={workspaceError} />;
  }

  if (!activeWorkspace) {
    return (
      <EmptyState
        icon={BarChart3}
        title="No workspace selected"
        message="Select a workspace to view its analytics."
      />
    );
  }

  return (
    <>
      <div className="flex items-center justify-between mb-6 gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Analytics & Performance</h1>
          <p className="text-sm text-foreground-muted">
            Real queue and delivery metrics across inbound and outbound pipelines
          </p>
        </div>

        {/* A plain <a> download navigation can't attach the x-workspace-id
            header, so the workspace id is passed as a query param instead —
            accepted by selectedWorkspace()'s fallback (header ?? workspace_id ?? id). */}
        <a
          href={`/api/leads/export?workspace_id=${activeWorkspace.id}`}
          download
          className="flex items-center gap-2 px-4 py-2.5 rounded-lg bg-brand-600 hover:bg-brand-500 text-white font-medium text-sm transition shadow-card"
        >
          <Download className="w-4 h-4" /> Export Qualified Leads (CSV)
        </a>
      </div>

      {error && !loading && (
        <ErrorState message={error} onRetry={load} className="mb-6" />
      )}

      {loading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
          {Array.from({ length: 4 }).map((_, idx) => (
            <Card key={idx}>
              <CardContent className="space-y-3 py-6">
                <Skeleton className="h-3 w-24" />
                <Skeleton className="h-8 w-16" />
                <Skeleton className="h-3 w-32" />
              </CardContent>
            </Card>
          ))}
        </div>
      ) : !error ? (
        <>
          {/* KPI Cards Grid */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
            {kpis.map((kpi) => {
              const Icon = kpi.icon;
              return (
                <Card key={kpi.label}>
                  <CardContent className="flex flex-col justify-between gap-4 py-6">
                    <div className="flex items-center justify-between">
                      <span className="text-foreground-muted text-xs font-semibold uppercase tracking-wider">
                        {kpi.label}
                      </span>
                      <Badge tone={kpi.tone} className="p-1.5">
                        <Icon className="w-4 h-4" />
                      </Badge>
                    </div>
                    <div>
                      <span className="text-3xl font-extrabold text-foreground">{kpi.value}</span>
                      <p className="mt-1 text-xs text-foreground-muted">{kpi.helper}</p>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>

          {/* Status Breakdown Cards */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <Card>
              <CardHeader>
                <CardTitle>Inbound Events by Status</CardTitle>
              </CardHeader>
              <CardContent>
                <StatusBreakdown counts={metrics?.inbound ?? {}} total={totalInbound} />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Outbound Jobs by Status</CardTitle>
              </CardHeader>
              <CardContent>
                <StatusBreakdown counts={metrics?.outbound ?? {}} total={totalOutbound} />
              </CardContent>
            </Card>
          </div>
        </>
      ) : null}
    </>
  );
}

const STATUS_COLORS: Record<string, string> = {
  received: 'bg-sky-500',
  queued: 'bg-sky-500',
  processing: 'bg-amber-500',
  processed: 'bg-emerald-500',
  sent: 'bg-emerald-500',
  pending: 'bg-amber-500',
  retryable_failed: 'bg-orange-500',
  permanent_failed: 'bg-rose-500',
  ambiguous: 'bg-purple-500',
};

function StatusBreakdown({ counts, total }: { counts: StatusCounts; total: number }) {
  const entries = Object.entries(counts);

  if (total === 0) {
    return <EmptyState icon={BarChart3} title="No events yet" message="Nothing has flowed through this queue yet." />;
  }

  return (
    <div className="space-y-4">
      {entries.map(([status, count]) => {
        const pct = total > 0 ? Math.round((count / total) * 100) : 0;
        return (
          <div key={status}>
            <div className="flex justify-between text-xs mb-1 font-medium text-foreground">
              <span>
                {status.replace(/_/g, ' ')} ({pct}%)
              </span>
              <span className="text-foreground-muted">{count.toLocaleString()}</span>
            </div>
            <div className="w-full h-3 bg-background-muted rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full ${STATUS_COLORS[status] ?? 'bg-brand-500'}`}
                style={{ width: `${pct}%` }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}
