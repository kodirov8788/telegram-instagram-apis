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
GitHub-hosted Actions are temporarily disabled because the repository account cannot
start hosted runners. Before approving any pull request, reviewers must run the
documented quality gates from a clean checkout with a supported Node.js version:

```bash
npm ci
npm run lint
npm run typecheck
npm test
npm run build
npm audit --audit-level=high
git diff --check
```

Database and RLS changes additionally require the opt-in `npm run test:db` check
with a safe `TEST_DATABASE_ADMIN_URL`. Restore hosted CI when the account-level
runner restriction is resolved.

## Database deployment

Apply `src/db/schema.sql` for fresh databases, or apply migrations in sequence (from `002_auth_rbac_rls.sql` through `011_delivery_uncertainty_contract.sql`) to the baseline schema, using the same
login configured in `DATABASE_URL`. The migration creates the fixed
`ydeck_tenant_runtime_v2` role as `NOLOGIN NOINHERIT` and grants that role to the
current migration login so runtime `SET LOCAL ROLE` works. The migration login
therefore needs `CREATEROLE` when the role does not exist; if the role is
pre-provisioned, it needs admin option on that role. Do not give the runtime
role a password, `LOGIN`, `INHERIT`, `BYPASSRLS`, or table ownership.

### Staged legacy identity reconciliation (009–010)

Migrations 006–008 preserve ambiguous legacy customer and conversation rows by
leaving their connection-scoped identities nullable. Fresh installations already
require these values. Upgrade installations converge on the same invariant through
an explicit two-stage gate:

1. Apply `009_identity_reconciliation_prepare.sql`. This only creates locked-down
   staging tables in `ydeck_migration`; it does not modify customer identities.
2. Stop identity-changing writes, then insert one reviewed row into
   `ydeck_migration.customer_identity_reconciliation` for every customer still
   missing `connection_id` or `provider_user_id`. Insert one reviewed row into
   `ydeck_migration.conversation_connection_reconciliation` for every conversation
   still missing `connection_id`. Mappings must come from authoritative provider or
   tenant records. Never infer a mapping merely because one active connection exists.
3. Back up the affected tables and review the mapping counts independently. Keep
   workers and webhook ingestion paused for the short finalization window.
4. Apply `010_identity_reconciliation_finalize.sql`. It rejects the entire batch on
   cross-workspace, cross-channel, customer/connection, conflicting, duplicate, or
   unresolved data. Errors report aggregate counts only and never log identifiers or
   message content.
5. Resume workers only after 010 commits. Confirm `customers.connection_id`,
   `customers.provider_user_id`, and `conversations.connection_id` are `NOT NULL` and
   all listed foreign-key, identity-pair, and provider-completion constraints are
   validated.

Migration 010 validates temporary `CHECK ... NOT VALID` constraints before issuing
`SET NOT NULL`. This moves the table scan outside the strongest lock, but the final
metadata change still takes an `ACCESS EXCLUSIVE` lock. Set an appropriate
`lock_timeout`, schedule the finalizer during a low-traffic window, and retry the
whole transaction if lock acquisition times out. If the gate fails, correct only the
staging mappings or source data and rerun 010; do not delete or guess legacy data.

Migration 011 adds the durable delivery-uncertainty contract. Deploy it before the
worker version that writes `dispatched_at`, `outbound_jobs.status = 'ambiguous'`, or
`messages.delivery_status = 'unknown'`. Older workers remain compatible because the
new timestamp is nullable and existing status values are unchanged.

## PGMQ Queue Deployment & Testing

This project incorporates the `pgmq` extension for durable, logged queue operations (`inbound_events` and `outbound_messages`).

### PGMQ Pre-requisites & Verification Environment
The verified local and integration environment uses:
- Postgres image: `ghcr.io/pgmq/pg18-pgmq:v1.10.0`
- Docker digest: `sha256:bfb3537068ce453609744518ece92b178ac89dff53747d47ca6fab91c2fc66a6`
- Extension version: `1.10.0` (or any compatible v1.x)

### Running Database Queue Integration Tests
A separate test suite exists specifically to verify PGMQ migrations and operations. It requires a test database admin connection URL:

```bash
TEST_QUEUE_DATABASE_URL='postgresql://postgres:postgres@localhost:5432/postgres' npm run test:queue:db
```

*Note: This command will refuse to run if `TEST_QUEUE_DATABASE_URL` is omitted, if `DATABASE_URL` is used, or if the target database name is production-like.*

### Deployment
Apply `src/db/migrations/005_pgmq_queues.sql` to your database. This migration:
1. Performs preflight checks to verify `pgmq` extension availability and compatibility.
2. Installs the `pgmq` extension.
3. Initializes the `inbound_events` and `outbound_messages` queues.
4. Revokes all public execute/select/update privileges on the `pgmq` schema from `PUBLIC`, `anon`, and `authenticated` roles to prevent PostgREST exposure.
5. Grants `ydeck_tenant_runtime_v2` access only to the fixed `ydeck_queue` security-definer wrappers. The runtime role receives no direct `pgmq` schema, function, queue-table, or archive-table privileges.

### Non-Destructive Rollback Instructions
To rollback `005_pgmq_queues.sql` without risk of message data loss:
1. **Stop Producers/Consumers**: Disable all active workers, webhook routes, and queue clients.
2. **Retain and Back Up Queue State**: Export/dump data from the following tables without dropping them:
   - Queue tables: `pgmq.q_inbound_events`, `pgmq.q_outbound_messages`
   - Archive tables: `pgmq.a_inbound_events`, `pgmq.a_outbound_messages`
3. **Disable Application Use**: Roll back producers and consumers or deploy a forward corrective migration while preserving active and archived messages.
4. **Replay Safely**: Use the durable provider-event ledger as the inbound replay source after the corrective deployment.

Do not run `pgmq.drop_queue` or `DROP EXTENSION pgmq CASCADE` as routine rollback operations; both can destroy recovery state.
