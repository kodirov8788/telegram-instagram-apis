import { query } from '../db';

export interface LeadScoringConfig {
  weights: { product: number; budget: number; timeline: number };
  thresholds: { qualified: number; highPriority: number };
}

export const DEFAULT_LEAD_SCORING_CONFIG: LeadScoringConfig = {
  weights: { product: 30, budget: 40, timeline: 30 },
  thresholds: { qualified: 70, highPriority: 90 },
};

function normalizeScoringConfig(raw: unknown): LeadScoringConfig {
  if (!raw || typeof raw !== 'object') return DEFAULT_LEAD_SCORING_CONFIG;
  const cfg = raw as Partial<LeadScoringConfig>;
  const weights = { ...DEFAULT_LEAD_SCORING_CONFIG.weights, ...(cfg.weights ?? {}) };
  const thresholds = { ...DEFAULT_LEAD_SCORING_CONFIG.thresholds, ...(cfg.thresholds ?? {}) };
  return { weights, thresholds };
}

export interface ExtractedLeadDTO {
  /** Trust anchor: workspace_id is resolved server-side from this connection, never accepted from caller input. */
  connectionId: string;
  customerId: string;
  conversationId: string;
  requestedProductOrService?: string;
  budget?: string;
  timeline?: string;
}

export interface SavedLead {
  id: string;
  workspace_id: string;
  customer_id: string;
  conversation_id: string | null;
  requested_product_or_service: string | null;
  budget: string | null;
  timeline: string | null;
  status: string;
  score: number;
  [key: string]: unknown;
}

export function computeLeadScoreAndStatus(
  data: Pick<ExtractedLeadDTO, 'requestedProductOrService' | 'budget' | 'timeline'>,
  config: LeadScoringConfig = DEFAULT_LEAD_SCORING_CONFIG,
): { score: number; status: string } {
  let score = 0;
  if (data.requestedProductOrService) score += config.weights.product;
  if (data.budget) score += config.weights.budget;
  if (data.timeline) score += config.weights.timeline;

  let status = 'new_lead';
  if (score >= config.thresholds.qualified) status = 'qualified';
  if (score >= config.thresholds.highPriority) status = 'high_priority';

  return { score, status };
}

export class LeadExtractorService {
  /**
   * Idempotent upsert: one lead per (workspace_id, customer_id) — see
   * migration 017's leads_workspace_customer_unique index. Repeated inbound
   * messages from the same customer update the existing lead's extracted
   * fields and score instead of creating duplicates. Only non-empty
   * extracted fields overwrite the stored value, so a later message with
   * less information doesn't erase previously captured details.
   */
  static async extractAndSaveLead(data: ExtractedLeadDTO): Promise<SavedLead> {
    if (!data.connectionId) throw new Error('connectionId is required to resolve the tenant workspace');

    const wsRes = await query(
      `SELECT w.id AS workspace_id, w.lead_scoring_config
       FROM channel_connections cc JOIN workspaces w ON w.id = cc.workspace_id
       WHERE cc.id = $1 AND cc.is_active = TRUE`,
      [data.connectionId],
    );
    const wsRow = wsRes.rows[0];
    if (!wsRow) throw new Error('No active channel connection found for connectionId');

    const config = normalizeScoringConfig(wsRow.lead_scoring_config);
    const { score, status } = computeLeadScoreAndStatus(data, config);

    const res = await query(
      `INSERT INTO leads (workspace_id, customer_id, conversation_id, requested_product_or_service, budget, timeline, score, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (workspace_id, customer_id) DO UPDATE SET
         conversation_id = EXCLUDED.conversation_id,
         requested_product_or_service = COALESCE(EXCLUDED.requested_product_or_service, leads.requested_product_or_service),
         budget = COALESCE(EXCLUDED.budget, leads.budget),
         timeline = COALESCE(EXCLUDED.timeline, leads.timeline),
         score = GREATEST(EXCLUDED.score, leads.score),
         status = CASE
           WHEN GREATEST(EXCLUDED.score, leads.score) >= $9 THEN 'high_priority'
           WHEN GREATEST(EXCLUDED.score, leads.score) >= $10 THEN 'qualified'
           ELSE leads.status
         END,
         updated_at = NOW()
       RETURNING *`,
      [
        wsRow.workspace_id,
        data.customerId,
        data.conversationId,
        data.requestedProductOrService ?? null,
        data.budget ?? null,
        data.timeline ?? null,
        score,
        status,
        config.thresholds.highPriority,
        config.thresholds.qualified,
      ],
    );

    return res.rows[0];
  }
}
