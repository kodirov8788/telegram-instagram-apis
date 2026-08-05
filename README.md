# Telegram & Instagram Unified Inbox APIs

Unified messaging API service and dashboard for managing Telegram and Instagram customer interactions with AI classification and lead extraction.

## Local Setup & Development

### Prerequisites
- Node.js `^20.19.0` or `>=22.12.0`
- npm v10+
- PostgreSQL database (optional for local mock testing)

### Installation
1. Clone the repository and install dependencies reproducibly:
   ```bash
   npm ci
   ```

2. Configure environment variables:
   ```bash
   cp .env.example .env.local
   ```
   Fill in your API keys in `.env.local`.

3. Run the development server:
   ```bash
   npm run dev
   ```
   Open [http://localhost:3000](http://localhost:3000) to view the application.

## Quality Gates & Verification

The project includes quality gate commands for build, test, lint, and type safety verification:

- **Linting (ESLint non-interactive)**:
  ```bash
  npm run lint
  ```
- **Type Checking**:
  ```bash
  npm run typecheck
  ```
- **Unit Testing (Vitest)**:
  ```bash
  npm test
  ```
- **Opt-in PostgreSQL/RLS integration test** (creates and deletes only a randomly
  named `ydeck_test_*` database; never reads `DATABASE_URL`):
  ```bash
  TEST_DATABASE_ADMIN_URL='postgresql://…/postgres' npm run test:db
  ```
- **Production Build**:
  ```bash
  npm run build
  ```
- **Dependency Audit**:
  ```bash
  npm audit --audit-level=high
  ```

### Dependency Audit Notes
Next.js and `eslint-config-next` are pinned to `15.5.21`. Vitest is pinned to `4.1.10`, and the PostCSS and Sharp overrides keep transitive dependencies on patched releases. The committed lockfile and full dependency audit cover both runtime and development tooling.

## Continuous Integration
GitHub Actions automatically runs all quality gates (`npm ci`, `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`, `npm audit`) on every push and pull request.

## Database deployment

Apply `src/db/schema.sql` for fresh databases, or apply
`src/db/migrations/002_auth_rbac_rls.sql` and then
`src/db/migrations/006_inbound_data_preflight.sql` to the baseline schema, using the same
login configured in `DATABASE_URL`. The migration creates the fixed
`ydeck_tenant_runtime_v2` role as `NOLOGIN NOINHERIT` and grants that role to the
current migration login so runtime `SET LOCAL ROLE` works. The migration login
therefore needs `CREATEROLE` when the role does not exist; if the role is
pre-provisioned, it needs admin option on that role. Do not give the runtime
role a password, `LOGIN`, `INHERIT`, `BYPASSRLS`, or table ownership.
