import { query } from '../db';

export interface AuditLogParams {
  workspaceId?: string;
  actorType: 'user' | 'ai_agent' | 'system';
  actorId?: string;
  action: string;
  entityType: string;
  entityId?: string;
  previousValue?: any;
  newValue?: any;
}

export class AuditLogService {
  static async logEvent(params: AuditLogParams) {
    try {
      await query(
        `INSERT INTO audit_logs (workspace_id, actor_type, actor_id, action, entity_type, entity_id, previous_value, new_value)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          params.workspaceId || null,
          params.actorType,
          params.actorId || null,
          params.action,
          params.entityType,
          params.entityId || null,
          params.previousValue ? JSON.stringify(params.previousValue) : null,
          params.newValue ? JSON.stringify(params.newValue) : null,
        ]
      );
    } catch (err) {
      console.error('Failed to log audit event:', err);
    }
  }
}
