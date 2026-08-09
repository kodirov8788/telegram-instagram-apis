export type KnowledgeCategory = "faq" | "catalog" | "policy" | "script";
export type KnowledgeLanguage = "uz" | "ru" | "en";

/**
 * Shape returned by the knowledge API routes, which pass through raw
 * (snake_case) DB rows from KnowledgeBaseService.
 */
export interface KnowledgeItem {
  id: string;
  workspace_id: string;
  title: string;
  content: string;
  category: KnowledgeCategory;
  language: KnowledgeLanguage;
  is_approved: boolean;
  valid_from: string | null;
  valid_until: string | null;
  created_at: string;
  updated_at: string;
}
