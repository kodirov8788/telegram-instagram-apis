"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Download, Users } from "lucide-react";
import { AppShell } from "@/components/shell";
import { SkeletonList } from "@/components/shell/Skeleton";
import { ErrorState } from "@/components/shell/ErrorState";
import { EmptyState } from "@/components/shell/EmptyState";
import {
  Badge,
  Button,
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui";
import { LeadDetailDialog } from "./LeadDetailDialog";
import { leadSource, statusTone } from "./utils";
import type { Lead, LeadStatus } from "./types";

const STATUSES: LeadStatus[] = [
  "unqualified",
  "new_lead",
  "interested",
  "qualified",
  "high_priority",
  "not_interested",
  "customer",
  "lost",
];

export default function LeadsPage() {
  const [leads, setLeads] = useState<Lead[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string>("");
  const [selectedLeadId, setSelectedLeadId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (status) params.set("status", status);
      const res = await fetch(`/api/leads?${params.toString()}`);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error || "Failed to load leads");
      setLeads(body.leads ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load leads");
    } finally {
      setLoading(false);
    }
  }, [status]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <AppShell>
      <div className="space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold text-foreground">Leads</h1>
            <p className="text-sm text-foreground-muted">
              Qualified prospects captured from Telegram and Instagram conversations.
            </p>
          </div>
          <Link href="/api/leads/export">
            <Button variant="secondary" size="md">
              <Download className="h-4 w-4" />
              Export CSV
            </Button>
          </Link>
        </div>

        <div className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-foreground" htmlFor="status-filter">
              Status
            </label>
            <select
              id="status-filter"
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              className="h-9 rounded-md border border-border-strong bg-background px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
            >
              <option value="">All statuses</option>
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s.replace(/_/g, " ")}
                </option>
              ))}
            </select>
          </div>
        </div>

        {loading && <SkeletonList rows={6} />}

        {!loading && error && <ErrorState message={error} onRetry={load} />}

        {!loading && !error && leads && leads.length === 0 && (
          <EmptyState
            icon={Users}
            title="No leads yet"
            message="Leads captured from conversations will show up here once available."
          />
        )}

        {!loading && !error && leads && leads.length > 0 && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Source</TableHead>
                <TableHead>Score</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Requested</TableHead>
                <TableHead>Created</TableHead>
                <TableHead>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {leads.map((lead) => (
                <TableRow key={lead.id}>
                  <TableCell className="font-medium text-foreground">{lead.full_name}</TableCell>
                  <TableCell>{leadSource(lead)}</TableCell>
                  <TableCell>{lead.score}</TableCell>
                  <TableCell>
                    <Badge tone={statusTone(lead.status)}>{lead.status.replace(/_/g, " ")}</Badge>
                  </TableCell>
                  <TableCell className="max-w-xs truncate">
                    {lead.requested_product_or_service ?? "—"}
                  </TableCell>
                  <TableCell>{new Date(lead.created_at).toLocaleDateString()}</TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => setSelectedLeadId(lead.id)}
                      >
                        View
                      </Button>
                      {lead.conversation_id ? (
                        <Link
                          href={`/inbox?conversationId=${lead.conversation_id}`}
                          className="text-sm font-medium text-brand-600 underline underline-offset-2 hover:text-brand-700"
                        >
                          Conversation
                        </Link>
                      ) : (
                        <span className="text-sm text-foreground-subtle">No conversation</span>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>

      <LeadDetailDialog leadId={selectedLeadId} onClose={() => setSelectedLeadId(null)} />
    </AppShell>
  );
}
