"use client";

import { useEffect, useState } from "react";
import { Dialog, DialogFooter } from "@/components/ui/Dialog";
import { Button, Input } from "@/components/ui";
import { ErrorBanner } from "@/components/shell/ErrorState";
import type { KnowledgeCategory, KnowledgeItem, KnowledgeLanguage } from "./types";

const CATEGORIES: KnowledgeCategory[] = ["faq", "catalog", "policy", "script"];
const LANGUAGES: KnowledgeLanguage[] = ["uz", "ru", "en"];

interface KnowledgeFormDialogProps {
  open: boolean;
  item: KnowledgeItem | null;
  onClose: () => void;
  onSaved: () => void;
}

interface FormState {
  title: string;
  content: string;
  category: KnowledgeCategory;
  language: KnowledgeLanguage;
  validFrom: string;
  validUntil: string;
}

const emptyForm: FormState = {
  title: "",
  content: "",
  category: "faq",
  language: "uz",
  validFrom: "",
  validUntil: "",
};

export function KnowledgeFormDialog({ open, item, onClose, onSaved }: KnowledgeFormDialogProps) {
  const [form, setForm] = useState<FormState>(emptyForm);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    if (item) {
      setForm({
        title: item.title,
        content: item.content,
        category: item.category,
        language: item.language,
        validFrom: item.valid_from ?? "",
        validUntil: item.valid_until ?? "",
      });
    } else {
      setForm(emptyForm);
    }
    setError(null);
  }, [open, item]);

  const isEdit = !!item;

  const submit = async () => {
    setSaving(true);
    setError(null);
    try {
      const payload: Record<string, unknown> = {
        title: form.title,
        content: form.content,
        category: form.category,
        language: form.language,
        validFrom: form.validFrom || null,
        validUntil: form.validUntil || null,
      };

      const res = await fetch(isEdit ? `/api/knowledge/${item!.id}` : "/api/knowledge", {
        method: isEdit ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error || "Failed to save knowledge item");
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save knowledge item");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={isEdit ? "Edit knowledge item" : "New knowledge item"}
      className="max-w-lg"
    >
      <div className="space-y-4">
        {error && <ErrorBanner message={error} />}

        <Input
          label="Title"
          value={form.title}
          onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
          required
        />

        <div className="flex flex-col gap-1.5">
          <label className="text-sm font-medium text-foreground" htmlFor="kb-content">
            Content
          </label>
          <textarea
            id="kb-content"
            value={form.content}
            onChange={(e) => setForm((f) => ({ ...f, content: e.target.value }))}
            rows={5}
            required
            className="w-full rounded-md border border-border-strong bg-background px-3 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-foreground" htmlFor="kb-category">
              Category
            </label>
            <select
              id="kb-category"
              value={form.category}
              onChange={(e) =>
                setForm((f) => ({ ...f, category: e.target.value as KnowledgeCategory }))
              }
              className="h-9 rounded-md border border-border-strong bg-background px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
            >
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-foreground" htmlFor="kb-language">
              Language
            </label>
            <select
              id="kb-language"
              value={form.language}
              onChange={(e) =>
                setForm((f) => ({ ...f, language: e.target.value as KnowledgeLanguage }))
              }
              className="h-9 rounded-md border border-border-strong bg-background px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
            >
              {LANGUAGES.map((l) => (
                <option key={l} value={l}>
                  {l.toUpperCase()}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Input
            label="Valid from"
            type="date"
            value={form.validFrom}
            onChange={(e) => setForm((f) => ({ ...f, validFrom: e.target.value }))}
          />
          <Input
            label="Valid until"
            type="date"
            value={form.validUntil}
            onChange={(e) => setForm((f) => ({ ...f, validUntil: e.target.value }))}
          />
        </div>
      </div>

      <DialogFooter>
        <Button variant="secondary" size="md" onClick={onClose} disabled={saving}>
          Cancel
        </Button>
        <Button
          variant="primary"
          size="md"
          onClick={submit}
          disabled={saving || !form.title.trim() || !form.content.trim()}
        >
          {saving ? "Saving…" : isEdit ? "Save changes" : "Create item"}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
