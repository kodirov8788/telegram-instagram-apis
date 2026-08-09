export type LeadStatus =
  | "unqualified"
  | "new_lead"
  | "interested"
  | "qualified"
  | "high_priority"
  | "not_interested"
  | "customer"
  | "lost";

/**
 * Shape returned by GET /api/leads and GET /api/leads/:id — raw
 * (snake_case) row joining `leads` with `customers`.
 */
export interface Lead {
  id: string;
  workspace_id: string;
  customer_id: string;
  conversation_id: string | null;
  full_name: string;
  phone_number: string | null;
  email: string | null;
  telegram_username: string | null;
  instagram_username: string | null;
  requested_product_or_service: string | null;
  budget: string | null;
  timeline: string | null;
  status: LeadStatus;
  score: number;
  assigned_user_id: string | null;
  next_action: string | null;
  created_at: string;
  updated_at: string;
}
