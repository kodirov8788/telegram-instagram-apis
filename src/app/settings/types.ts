export interface Workspace {
  id: string;
  name: string;
  industry: string | null;
  time_zone?: string | null;
  timeZone?: string | null;
  default_language?: string | null;
  defaultLanguage?: string | null;
  working_hours?: unknown;
  workingHours?: unknown;
  created_at?: string;
}

export type Role =
  | "owner"
  | "admin"
  | "sales_manager"
  | "sales_representative"
  | "support_operator"
  | "read_only_analyst";

export interface Member {
  user_id: string;
  email: string;
  full_name: string | null;
  role: Role;
  created_at: string;
}

export const ASSIGNABLE_ROLES: Role[] = [
  "admin",
  "sales_manager",
  "sales_representative",
  "support_operator",
  "read_only_analyst",
];
