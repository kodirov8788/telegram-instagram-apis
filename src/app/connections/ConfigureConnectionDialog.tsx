"use client";

import { FormEvent, useState } from "react";
import { Button, Dialog, DialogFooter, Input } from "@/components/ui";
import type { Connection } from "./types";

export interface ConfigureConnectionDialogProps {
  connection: Connection;
  open: boolean;
  onClose: () => void;
  onSaved: (updated: Connection) => void;
}

/**
 * Dialog for updating a connection's account identifier / active state, and
 * optionally rotating its stored credential.
 *
 * Security: the credential field is write-only. It is never pre-filled from
 * the server (the API never returns a resolved secret value in the first
 * place — `Connection` has no field for it) and its value is cleared from
 * local state as soon as the request completes, win or lose.
 */
export function ConfigureConnectionDialog({
  connection,
  open,
  onClose,
  onSaved,
}: ConfigureConnectionDialogProps) {
  const [accountIdentifier, setAccountIdentifier] = useState(connection.account_identifier);
  const [isActive, setIsActive] = useState(connection.is_active);
  const [credentialInput, setCredentialInput] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const credentialFieldName = connection.channel === "telegram" ? "token" : "access_token";

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {
        accountIdentifier,
        isActive,
      };
      if (credentialInput.trim().length > 0) {
        body.credential = { [credentialFieldName]: credentialInput.trim() };
      }

      const res = await fetch(`/api/connections/${connection.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      // Clear the credential from local state immediately regardless of
      // outcome — never let a typed secret linger in memory/DOM longer than
      // needed to submit it.
      setCredentialInput("");

      if (!res.ok) {
        const payload = await res.json().catch(() => null);
        setError(payload?.error ?? `Request failed (${res.status})`);
        return;
      }

      const payload = await res.json();
      onSaved(payload.connection as Connection);
      onClose();
    } catch {
      setError("Network error — please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`Configure ${connection.channel === "telegram" ? "Telegram" : "Instagram"} connection`}
      description="Update this connection's details, or set a new credential."
    >
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <Input
          label="Account identifier"
          value={accountIdentifier}
          onChange={(e) => setAccountIdentifier(e.target.value)}
          required
        />

        <label className="flex items-center gap-2 text-sm text-foreground">
          <input
            type="checkbox"
            checked={isActive}
            onChange={(e) => setIsActive(e.target.checked)}
            className="h-4 w-4 rounded border-border-strong"
          />
          Active
        </label>

        <div className="flex flex-col gap-1.5 rounded-md border border-border-strong p-3">
          <label htmlFor="credential" className="text-sm font-medium text-foreground">
            New credential (write-only)
          </label>
          <p className="text-xs text-foreground-muted">
            {connection.channel === "telegram"
              ? "Paste a new bot token to replace the stored one."
              : "Paste a new access token to replace the stored one."}{" "}
            For security, an existing credential is never shown here — leave this blank to keep it unchanged.
          </p>
          <input
            id="credential"
            type="password"
            autoComplete="off"
            value={credentialInput}
            onChange={(e) => setCredentialInput(e.target.value)}
            placeholder="Leave blank to keep current credential"
            className="h-9 w-full rounded-md border border-border-strong bg-background px-3 text-sm text-foreground placeholder:text-foreground-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 focus-visible:ring-offset-background"
          />
        </div>

        {error && <p className="text-sm text-rose-600">{error}</p>}

        <DialogFooter>
          <Button type="button" variant="secondary" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={submitting}>
            {submitting ? "Saving…" : "Save changes"}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
