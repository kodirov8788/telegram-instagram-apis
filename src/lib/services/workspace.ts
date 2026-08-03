import { query, type DbClient } from '../db';

export interface WorkspaceConfig {
  id?: string;
  name: string;
  industry?: string;
  timeZone?: string;
  defaultLanguage?: 'uz' | 'ru' | 'en';
  workingHours?: {
    start: string;
    end: string;
    days: number[];
  };
}

export class WorkspaceService {
  static async createWorkspace(config: WorkspaceConfig, client: DbClient) {
      const wsResult = await client.query(
        `SELECT * FROM bootstrap_workspace($1, $2, $3, $4, $5)`,
        [
          config.name,
          config.industry || 'general',
          config.timeZone || 'Asia/Tashkent',
          config.defaultLanguage || 'uz',
          JSON.stringify(config.workingHours || { start: '09:00', end: '18:00', days: [1, 2, 3, 4, 5] })
        ]
      );
      return wsResult.rows[0];
  }

  static async getWorkspaceById(workspaceId: string, client: DbClient = { query }) {
    const res = await client.query(`SELECT * FROM workspaces WHERE id = $1`, [workspaceId]);
    return res.rows[0] || null;
  }

  static async updateWorkspaceConfig(workspaceId: string, updates: Partial<WorkspaceConfig>, client: DbClient = { query }) {
    const res = await client.query(
      `UPDATE workspaces 
       SET name = COALESCE($1, name),
           industry = COALESCE($2, industry),
           default_language = COALESCE($3, default_language),
           working_hours = COALESCE($4, working_hours),
           updated_at = NOW()
       WHERE id = $5
       RETURNING *`,
      [
        updates.name,
        updates.industry,
        updates.defaultLanguage,
        updates.workingHours ? JSON.stringify(updates.workingHours) : null,
        workspaceId
      ]
    );
    return res.rows[0];
  }
}
