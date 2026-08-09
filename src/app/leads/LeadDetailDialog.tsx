"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Dialog, DialogFooter } from "@/components/ui/Dialog";
import { Badge, Button } from "@/components/ui";
import { SkeletonText } from "@/components/shell/Skeleton";
import { ErrorBanner } from "@/components/shell/ErrorState";
import type { Lead } from "./types";
import { leadSource, statusTone } from "./utils";
import { useWorkspace } from "@/lib/workspace/context";

interface LeadDetailDialogProps {
  leadId: string | null;
  onClose: () => void;
}

export function LeadDetailDialog({ leadId, onClose }: LeadDetailDialogProps) {
  const { apiFetch } = useWorkspace();
  const [lead, setLead] = useState<Lead | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!leadId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setLead(null);

    apiFetch(`/api/leads/${leadId}`)
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body?.error || "Failed to load lead");
        if (!cancelled) setLead(body.lead);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load lead");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [leadId, apiFetch]);

  return (
    <Dialog open={!!leadId} onClose={onClose} title="Lead detail" className="max-w-lg">
      {loading && <SkeletonText lines={6} />}
      {!loading && error && <ErrorBanner message={error} />}

      {!loading && !error && lead && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-base font-semibold text-foreground">{lead.full_name}</p>
              <p className="text-sm text-foreground-muted">{leadSource(lead)}</p>
            </div>
            <div className="flex flex-col items-end gap-1">
              <Badge tone={statusTone(lead.status)}>{lead.status.replace(/_/g, " ")}</Badge>
              <span className="text-xs text-foreground-muted">Score: {lead.score}</span>
            </div>
          </div>

          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
            <dt className="text-foreground-muted">Phone</dt>
            <dd className="text-foreground">{lead.phone_number ?? "—"}</dd>
            <dt className="text-foreground-muted">Email</dt>
            <dd className="text-foreground">{lead.email ?? "—"}</dd>
            <dt className="text-foreground-muted">Telegram</dt>
            <dd className="text-foreground">{lead.telegram_username ?? "—"}</dd>
            <dt className="text-foreground-muted">Instagram</dt>
            <dd className="text-foreground">{lead.instagram_username ?? "—"}</dd>
            <dt className="text-foreground-muted">Requested product/service</dt>
            <dd className="text-foreground">{lead.requested_product_or_service ?? "—"}</dd>
            <dt className="text-foreground-muted">Budget</dt>
            <dd className="text-foreground">{lead.budget ?? "—"}</dd>
            <dt className="text-foreground-muted">Timeline</dt>
            <dd className="text-foreground">{lead.timeline ?? "—"}</dd>
            <dt className="text-foreground-muted">Next action</dt>
            <dd className="text-foreground">{lead.next_action ?? "—"}</dd>
            <dt className="text-foreground-muted">Created</dt>
            <dd className="text-foreground">{new Date(lead.created_at).toLocaleString()}</dd>
            <dt className="text-foreground-muted">Updated</dt>
            <dd className="text-foreground">{new Date(lead.updated_at).toLocaleString()}</dd>
          </dl>

          {lead.conversation_id && (
            <Link
              href={`/inbox?conversationId=${lead.conversation_id}`}
              className="text-sm font-medium text-brand-600 underline underline-offset-2 hover:text-brand-700"
            >
              View linked conversation
            </Link>
          )}
        </div>
      )}

      <DialogFooter>
        <Button variant="secondary" size="md" onClick={onClose}>
          Close
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
