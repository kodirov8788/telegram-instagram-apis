import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../db', () => ({ query: vi.fn() }));

import { query } from '../../db';
import { LeadExtractorService, computeLeadScoreAndStatus, DEFAULT_LEAD_SCORING_CONFIG } from '../lead-extractor';

const db = vi.mocked(query);

beforeEach(() => {
  db.mockReset();
});

describe('computeLeadScoreAndStatus', () => {
  it('applies default weights and thresholds', () => {
    expect(computeLeadScoreAndStatus({ requestedProductOrService: 'x' })).toEqual({ score: 30, status: 'new_lead' });
    expect(computeLeadScoreAndStatus({ requestedProductOrService: 'x', budget: '100' })).toEqual({ score: 70, status: 'qualified' });
    expect(computeLeadScoreAndStatus({ requestedProductOrService: 'x', budget: '100', timeline: 'soon' })).toEqual({ score: 100, status: 'high_priority' });
    expect(computeLeadScoreAndStatus({})).toEqual({ score: 0, status: 'new_lead' });
  });

  it('honours a configurable scoring config', () => {
    const config = { weights: { product: 10, budget: 10, timeline: 10 }, thresholds: { qualified: 20, highPriority: 30 } };
    expect(computeLeadScoreAndStatus({ requestedProductOrService: 'x', budget: '1' }, config)).toEqual({ score: 20, status: 'qualified' });
    expect(computeLeadScoreAndStatus({ requestedProductOrService: 'x', budget: '1', timeline: 't' }, config)).toEqual({ score: 30, status: 'high_priority' });
  });

  it('exposes sane defaults', () => {
    expect(DEFAULT_LEAD_SCORING_CONFIG.weights).toEqual({ product: 30, budget: 40, timeline: 30 });
    expect(DEFAULT_LEAD_SCORING_CONFIG.thresholds).toEqual({ qualified: 70, highPriority: 90 });
  });
});

describe('LeadExtractorService.extractAndSaveLead', () => {
  const baseData = {
    connectionId: 'conn-1',
    customerId: 'cust-1',
    conversationId: 'conv-1',
    requestedProductOrService: 'sofa',
    budget: '$500',
  };

  it('resolves workspace via the connection and rejects a missing/inactive connection', async () => {
    db.mockResolvedValueOnce({ rows: [] } as never);
    await expect(LeadExtractorService.extractAndSaveLead(baseData)).rejects.toThrow(/No active channel connection/);
    expect(db).toHaveBeenCalledWith(expect.stringContaining('channel_connections'), ['conn-1']);
  });

  it('upserts a lead scoped to the resolved workspace using default scoring when no config is set', async () => {
    db.mockResolvedValueOnce({ rows: [{ workspace_id: 'ws-1', lead_scoring_config: null }] } as never);
    db.mockResolvedValueOnce({ rows: [{ id: 'lead-1', workspace_id: 'ws-1', status: 'qualified', score: 70 }] } as never);

    const result = await LeadExtractorService.extractAndSaveLead(baseData);

    expect(result).toEqual({ id: 'lead-1', workspace_id: 'ws-1', status: 'qualified', score: 70 });
    const [sql, params] = db.mock.calls[1] as [string, unknown[]];
    expect(sql).toContain('ON CONFLICT (workspace_id, customer_id)');
    expect(params).toEqual(['ws-1', 'cust-1', 'conv-1', 'sofa', '$500', null, 70, 'qualified', 90, 70]);
  });

  it('uses a per-workspace scoring config when present', async () => {
    const config = { weights: { product: 10, budget: 10, timeline: 10 }, thresholds: { qualified: 15, highPriority: 25 } };
    db.mockResolvedValueOnce({ rows: [{ workspace_id: 'ws-1', lead_scoring_config: config }] } as never);
    db.mockResolvedValueOnce({ rows: [{ id: 'lead-1', score: 20, status: 'qualified' }] } as never);

    await LeadExtractorService.extractAndSaveLead(baseData);

    const [, params] = db.mock.calls[1] as [string, unknown[]];
    expect(params[6]).toBe(20); // score: product(10) + budget(10)
    expect(params[7]).toBe('qualified'); // status
    expect(params[8]).toBe(25); // highPriority threshold
    expect(params[9]).toBe(15); // qualified threshold
  });

  it('throws when connectionId is missing', async () => {
    await expect(LeadExtractorService.extractAndSaveLead({ ...baseData, connectionId: '' })).rejects.toThrow(/connectionId is required/);
    expect(db).not.toHaveBeenCalled();
  });
});
