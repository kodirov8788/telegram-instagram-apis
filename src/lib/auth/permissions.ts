export const roles = ['owner', 'admin', 'sales_manager', 'sales_representative', 'support_operator', 'read_only_analyst'] as const;
export type Role = typeof roles[number];
export type Permission =
  | 'workspace:read' | 'workspace:update'
  | 'conversation:read' | 'conversation:update'
  | 'leads:export' | 'leads:read'
  | 'members:read' | 'members:invite' | 'members:update' | 'members:remove'
  | 'knowledge:read' | 'knowledge:write';

const permissions: Record<Permission, readonly Role[]> = {
  'workspace:read': roles,
  'workspace:update': ['owner', 'admin'],
  'conversation:read': roles,
  'conversation:update': ['owner', 'admin', 'sales_manager', 'sales_representative', 'support_operator'],
  'leads:export': ['owner', 'admin', 'sales_manager', 'read_only_analyst'],
  'leads:read': ['owner', 'admin', 'sales_manager', 'sales_representative', 'read_only_analyst'],
  'members:read': ['owner', 'admin'],
  'members:invite': ['owner', 'admin'],
  'members:update': ['owner', 'admin'],
  'members:remove': ['owner', 'admin'],
  'knowledge:read': roles,
  'knowledge:write': ['owner', 'admin', 'sales_manager', 'support_operator'],
};

export function can(role: string, permission: Permission): role is Role {
  return permissions[permission].includes(role as Role);
}
