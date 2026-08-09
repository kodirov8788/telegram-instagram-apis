export const roles = ['owner', 'admin', 'sales_manager', 'sales_representative', 'support_operator', 'read_only_analyst'] as const;
export type Role = typeof roles[number];
export type Permission =
  | 'workspace:read' | 'workspace:update'
  | 'conversation:read' | 'conversation:update'
  | 'leads:export' | 'leads:read'
  | 'members:read' | 'members:invite' | 'members:update' | 'members:remove'
  | 'knowledge:read' | 'knowledge:write'
  | 'connections:read' | 'connections:write';

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
  // Connections carry per-tenant provider credentials (vault-backed). Read
  // is scoped narrower than knowledge:read (no non-secret-shaped health
  // summary is worth exposing to every role) and write/test are owner+admin
  // only, since write can rotate credentials and test makes a live provider
  // call using them.
  'connections:read': ['owner', 'admin', 'sales_manager', 'support_operator'],
  'connections:write': ['owner', 'admin'],
};

export function can(role: string, permission: Permission): role is Role {
  return permissions[permission].includes(role as Role);
}
