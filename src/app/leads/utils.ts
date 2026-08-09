import type { BadgeTone } from "@/components/ui";
import type { Lead, LeadStatus } from "./types";

/** Leads have no direct "source/channel" column — derive it from which
 * customer identity field is populated (mirrors inbox's channel concept). */
export function leadSource(lead: Lead): string {
  if (lead.telegram_username) return "Telegram";
  if (lead.instagram_username) return "Instagram";
  return "Unknown";
}

export function statusTone(status: LeadStatus): BadgeTone {
  switch (status) {
    case "qualified":
    case "customer":
      return "success";
    case "high_priority":
      return "brand";
    case "interested":
    case "new_lead":
      return "secondary";
    case "not_interested":
    case "lost":
    case "unqualified":
      return "error";
    default:
      return "neutral";
  }
}
