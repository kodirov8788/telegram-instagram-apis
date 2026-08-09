"use client";

import { useCallback, useEffect, useState } from "react";
import { BookOpen, Plus } from "lucide-react";
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
import { KnowledgeFormDialog } from "./KnowledgeFormDialog";
import type { KnowledgeItem, KnowledgeCategory, KnowledgeLanguage } from "./types";
import { useWorkspace } from "@/lib/workspace/context";

const CATEGORIES: KnowledgeCategory[] = ["faq", "catalog", "policy", "script"];
const LANGUAGES: KnowledgeLanguage[] = ["uz", "ru", "en"];

function isExpired(item: KnowledgeItem): boolean {
  if (!item.valid_until) return false;
  return new Date(item.valid_until) < new Date(new Date().toDateString());
}

function isUpcoming(item: KnowledgeItem): boolean {
  if (!item.valid_from) return false;
  return new Date(item.valid_from) > new Date(new Date().toDateString());
}

export default function KnowledgePage() {
  // useWorkspace() must be called from a descendant of the WorkspaceProvider
  // AppShell mounts — this page renders AppShell itself, so the actual body
  // lives in KnowledgePageInner, rendered as AppShell's child.
  return (
    <AppShell>
      <KnowledgePageInner />
    </AppShell>
  );
}

function KnowledgePageInner() {
  const { apiFetch, activeWorkspace, loading: workspaceLoading, error: workspaceError } = useWorkspace();
  const [items, setItems] = useState<KnowledgeItem[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [category, setCategory] = useState<string>("");
  const [language, setLanguage] = useState<string>("");
  const [approval, setApproval] = useState<string>("");

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingItem, setEditingItem] = useState<KnowledgeItem | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!activeWorkspace) return;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (category) params.set("category", category);
      if (language) params.set("language", language);
      if (approval) params.set("isApproved", approval);

      const res = await apiFetch(`/api/knowledge?${params.toString()}`);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error || "Failed to load knowledge items");
      setItems(body.items ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load knowledge items");
    } finally {
      setLoading(false);
    }
  }, [category, language, approval, apiFetch, activeWorkspace]);

  useEffect(() => {
    if (activeWorkspace) load();
  }, [load, activeWorkspace]);

  const openCreate = () => {
    setEditingItem(null);
    setDialogOpen(true);
  };

  const openEdit = (item: KnowledgeItem) => {
    setEditingItem(item);
    setDialogOpen(true);
  };

  const toggleApproval = async (item: KnowledgeItem) => {
    setBusyId(item.id);
    try {
      const res = await apiFetch(`/api/knowledge/${item.id}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isApproved: !item.is_approved }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error || "Failed to update approval");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update approval");
    } finally {
      setBusyId(null);
    }
  };

  if (workspaceLoading) {
    return <SkeletonList rows={6} />;
  }

  if (workspaceError) {
    return <ErrorState title="Couldn't load your workspace" message={workspaceError} />;
  }

  if (!activeWorkspace) {
    return (
      <EmptyState
        icon={BookOpen}
        title="No workspace selected"
        message="Select a workspace to manage its knowledge base."
      />
    );
  }

  return (
    <>
      <div className="space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold text-foreground">Knowledge base</h1>
            <p className="text-sm text-foreground-muted">
              Manage FAQ, catalog, policy, and script content used by the AI assistant.
            </p>
          </div>
          <Button variant="primary" size="md" onClick={openCreate}>
            <Plus className="h-4 w-4" />
            New item
          </Button>
        </div>

        <div className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-foreground" htmlFor="category-filter">
              Category
            </label>
            <select
              id="category-filter"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="h-9 rounded-md border border-border-strong bg-background px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
            >
              <option value="">All categories</option>
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-foreground" htmlFor="language-filter">
              Language
            </label>
            <select
              id="language-filter"
              value={language}
              onChange={(e) => setLanguage(e.target.value)}
              className="h-9 rounded-md border border-border-strong bg-background px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
            >
              <option value="">All languages</option>
              {LANGUAGES.map((l) => (
                <option key={l} value={l}>
                  {l.toUpperCase()}
                </option>
              ))}
            </select>
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-foreground" htmlFor="approval-filter">
              Approval
            </label>
            <select
              id="approval-filter"
              value={approval}
              onChange={(e) => setApproval(e.target.value)}
              className="h-9 rounded-md border border-border-strong bg-background px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
            >
              <option value="">All statuses</option>
              <option value="true">Approved</option>
              <option value="false">Pending</option>
            </select>
          </div>
        </div>

        {loading && <SkeletonList rows={6} />}

        {!loading && error && <ErrorState message={error} onRetry={load} />}

        {!loading && !error && items && items.length === 0 && (
          <EmptyState
            icon={BookOpen}
            title="No knowledge items"
            message="Create the first knowledge item to help the AI assistant answer accurately."
            action={{ label: "New item", onClick: openCreate }}
          />
        )}

        {!loading && !error && items && items.length > 0 && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Title</TableHead>
                <TableHead>Category</TableHead>
                <TableHead>Language</TableHead>
                <TableHead>Approval</TableHead>
                <TableHead>Validity</TableHead>
                <TableHead>Updated</TableHead>
                <TableHead>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((item) => (
                <TableRow key={item.id}>
                  <TableCell className="max-w-xs">
                    <div className="font-medium text-foreground">{item.title}</div>
                    <div className="line-clamp-1 text-xs text-foreground-muted">
                      {item.content}
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge tone="secondary">{item.category}</Badge>
                  </TableCell>
                  <TableCell>{(item.language ?? "").toUpperCase()}</TableCell>
                  <TableCell>
                    <Badge tone={item.is_approved ? "success" : "warning"}>
                      {item.is_approved ? "Approved" : "Pending"}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-col gap-1 text-xs text-foreground-muted">
                      <span>
                        {item.valid_from ?? "—"} → {item.valid_until ?? "—"}
                      </span>
                      {isExpired(item) && <Badge tone="error">Expired</Badge>}
                      {!isExpired(item) && isUpcoming(item) && (
                        <Badge tone="warning">Upcoming</Badge>
                      )}
                    </div>
                  </TableCell>
                  <TableCell>
                    {item.updated_at ? new Date(item.updated_at).toLocaleDateString() : "—"}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <Button variant="secondary" size="sm" onClick={() => openEdit(item)}>
                        Edit
                      </Button>
                      <Button
                        variant={item.is_approved ? "destructive" : "primary"}
                        size="sm"
                        disabled={busyId === item.id}
                        onClick={() => toggleApproval(item)}
                      >
                        {item.is_approved ? "Unapprove" : "Approve"}
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>

      <KnowledgeFormDialog
        open={dialogOpen}
        item={editingItem}
        onClose={() => setDialogOpen(false)}
        onSaved={() => {
          setDialogOpen(false);
          load();
        }}
      />
    </>
  );
}
