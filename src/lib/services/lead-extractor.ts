import pool, { query } from '../db';

export interface ExtractedLeadDTO {
  workspaceId: string;
  customerId: string;
  conversationId: string;
  requestedProductOrService?: string;
  budget?: string;
  timeline?: string;
  score?: number;
}

export class LeadExtractorService {
  static async extractAndSaveLead(data: ExtractedLeadDTO) {
    let score = 0;
    if (data.requestedProductOrService) score += 30;
    if (data.budget) score += 40;
    if (data.timeline) score += 30;

    let status = 'new_lead';
    if (score >= 70) status = 'qualified';
    if (score >= 90) status = 'high_priority';

    const res = await query(
      `INSERT INTO leads (workspace_id, customer_id, conversation_id, requested_product_or_service, budget, timeline, score, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [data.workspaceId, data.customerId, data.conversationId, data.requestedProductOrService, data.budget, data.timeline, score, status]
    );

    return res.rows[0];
  }
}
