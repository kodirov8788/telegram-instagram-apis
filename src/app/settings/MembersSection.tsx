"use client";

import { useEffect, useState } from "react";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui";
import { ErrorBanner, SkeletonList } from "@/components/shell";
import { ASSIGNABLE_ROLES, type Member, type Role } from "./types";
import { useWorkspace } from "@/lib/workspace/context";

/**
 * Team/members list with role management. The API is the source of truth
 * for permissions (403s are expected for insufficient roles and are
 * surfaced inline, not hidden) — this UI does not try to guess the
 * viewer's own role to hide actions client-side.
 */
export function MembersSection() {
  const { apiFetch } = useWorkspace();
  const [members, setMembers] = useState<Member[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [rowPending, setRowPending] = useState<Record<string, boolean>>({});

  async function loadMembers() {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await apiFetch("/api/workspace/members");
      if (!res.ok) {
        const payload = await res.json().catch(() => null);
        setLoadError(payload?.error ?? `Failed to load members (${res.status})`);
        return;
      }
      const payload = await res.json();
      setMembers(payload.members as Member[]);
    } catch {
      setLoadError("Network error — please try again.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadMembers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiFetch]);

  async function handleRoleChange(userId: string, role: Role) {
    setRowPending((prev) => ({ ...prev, [userId]: true }));
    setRowErrors((prev) => ({ ...prev, [userId]: "" }));
    try {
      const res = await apiFetch(`/api/workspace/members/${userId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role }),
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => null);
        const message =
          res.status === 403
            ? "You don't have permission to change this member's role."
            : payload?.error ?? `Failed to update role (${res.status})`;
        setRowErrors((prev) => ({ ...prev, [userId]: message }));
        return;
      }
      const payload = await res.json();
      setMembers((prev) =>
        prev ? prev.map((m) => (m.user_id === userId ? { ...m, role: payload.member.role } : m)) : prev
      );
    } catch {
      setRowErrors((prev) => ({ ...prev, [userId]: "Network error — please try again." }));
    } finally {
      setRowPending((prev) => ({ ...prev, [userId]: false }));
    }
  }

  async function handleRemove(userId: string) {
    setRowPending((prev) => ({ ...prev, [userId]: true }));
    setRowErrors((prev) => ({ ...prev, [userId]: "" }));
    try {
      const res = await apiFetch(`/api/workspace/members/${userId}`, { method: "DELETE" });
      if (!res.ok && res.status !== 204) {
        const payload = await res.json().catch(() => null);
        const message =
          res.status === 403
            ? "You don't have permission to remove this member."
            : payload?.error ?? `Failed to remove member (${res.status})`;
        setRowErrors((prev) => ({ ...prev, [userId]: message }));
        return;
      }
      setMembers((prev) => (prev ? prev.filter((m) => m.user_id !== userId) : prev));
    } catch {
      setRowErrors((prev) => ({ ...prev, [userId]: "Network error — please try again." }));
    } finally {
      setRowPending((prev) => ({ ...prev, [userId]: false }));
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Team members</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {loading && <SkeletonList rows={3} />}
        {!loading && loadError && <ErrorBanner message={loadError} onRetry={loadMembers} />}
        {!loading && !loadError && members && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Member</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Joined</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {members.map((member) => (
                <TableRow key={member.user_id}>
                  <TableCell>
                    <div className="flex flex-col">
                      <span className="font-medium">{member.full_name ?? member.email}</span>
                      <span className="text-xs text-foreground-muted">{member.email}</span>
                    </div>
                  </TableCell>
                  <TableCell>
                    {member.role === "owner" ? (
                      <Badge tone="brand">Owner</Badge>
                    ) : (
                      <select
                        value={member.role}
                        disabled={rowPending[member.user_id]}
                        onChange={(e) => handleRoleChange(member.user_id, e.target.value as Role)}
                        className="h-8 rounded-md border border-border-strong bg-background px-2 text-sm text-foreground"
                      >
                        {ASSIGNABLE_ROLES.map((role) => (
                          <option key={role} value={role}>
                            {role.replace(/_/g, " ")}
                          </option>
                        ))}
                      </select>
                    )}
                  </TableCell>
                  <TableCell>{new Date(member.created_at).toLocaleDateString()}</TableCell>
                  <TableCell>
                    {member.role !== "owner" && (
                      <Button
                        variant="destructive"
                        size="sm"
                        disabled={rowPending[member.user_id]}
                        onClick={() => handleRemove(member.user_id)}
                      >
                        Remove
                      </Button>
                    )}
                    {rowErrors[member.user_id] && (
                      <p className="mt-1 text-xs text-rose-600">{rowErrors[member.user_id]}</p>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
