import pool, { query } from '../db';

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
  static async createWorkspace(config: WorkspaceConfig, ownerUserId: string) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      
      const wsResult = await client.query(
        `INSERT INTO workspaces (name, industry, time_zone, default_language, working_hours)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [
          config.name,
          config.industry || 'general',
          config.timeZone || 'Asia/Tashkent',
          config.defaultLanguage || 'uz',
          JSON.stringify(config.workingHours || { start: '09:00', end: '18:00', days: [1, 2, 3, 4, 5] })
        ]
      );
      
      const workspace = wsResult.rows[0];

      // Assign Owner role
      await client.query(
        `INSERT INTO workspace_members (workspace_id, user_id, role)
         VALUES ($1, $2, 'owner')`,
        [workspace.id, ownerUserId]
      );

      await client.query('COMMIT');
      return workspace;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  static async getWorkspaceById(workspaceId: string) {
    const res = await query(`SELECT * FROM workspaces WHERE id = $1`, [workspaceId]);
    return res.rows[0] || null;
  }

  static async updateWorkspaceConfig(workspaceId: string, updates: Partial<WorkspaceConfig>) {
    const res = await query(
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
