-- Issue #33: configurable lead scoring + idempotent lead upsert.
--
-- 1. Per-workspace scoring config (JSONB, nullable — NULL means "use the
--    built-in default weights/thresholds"). Kept intentionally simple: a
--    flat weights/thresholds object, not a rules engine.
-- 2. A uniqueness guarantee on (workspace_id, customer_id) so repeated
--    inbound messages from the same customer upsert one lead row instead
--    of inserting duplicates.

ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS lead_scoring_config JSONB;

-- One lead per customer per workspace. A customer may have many
-- conversations over time; they still resolve to a single evolving lead
-- record, which is also the simplest idempotent target for ON CONFLICT
-- upserts from the inbound pipeline.
CREATE UNIQUE INDEX IF NOT EXISTS leads_workspace_customer_unique
  ON leads(workspace_id, customer_id);
