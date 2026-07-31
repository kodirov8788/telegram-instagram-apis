import { query } from '../db';

export class FollowUpSchedulerService {
  static async checkPendingFollowUps(workspaceId: string) {
    // Select qualified leads with no response in 24 hours
    const res = await query(
      `SELECT c.id as conversation_id, c.customer_id, c.channel, cust.telegram_id, cust.instagram_id
       FROM conversations c
       JOIN customers cust ON c.customer_id = cust.id
       WHERE c.workspace_id = $1 
         AND c.status = 'qualified_lead'
         AND c.last_message_at < NOW() - INTERVAL '24 hours'`,
      [workspaceId]
    );

    console.log(`Found ${res.rows.length} pending follow-up candidates.`);
    return res.rows;
  }
}
