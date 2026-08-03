import { describe, expect, it } from 'vitest';
import { can, roles, type Permission } from '../permissions';

const matrix: Record<Permission, string[]> = {
  'workspace:read': [...roles],
  'workspace:update': ['owner', 'admin'],
  'conversation:read': [...roles],
  'conversation:update': ['owner', 'admin', 'sales_manager', 'sales_representative', 'support_operator'],
  'leads:export': ['owner', 'admin', 'sales_manager', 'read_only_analyst'],
  'members:read': ['owner', 'admin'],
  'members:invite': ['owner', 'admin'],
  'members:update': ['owner', 'admin'],
  'members:remove': ['owner', 'admin'],
};

describe('PRD role permissions', () => {
  for (const permission of Object.keys(matrix) as Permission[]) {
    for (const role of roles) {
      it(`${role} ${matrix[permission].includes(role) ? 'may' : 'may not'} ${permission}`, () => {
        expect(can(role, permission)).toBe(matrix[permission].includes(role));
      });
    }
  }
});
