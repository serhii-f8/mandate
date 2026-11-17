-- EXE-3, EXE-7, POL-6: guards for the execution columns and batch rows (design phase-5-execution).
-- Messages are fixed texts: they never carry column values (SEC-3).

-- Code-point order for batch bookkeeping, the same order as change_item.target_id.
-- The table is empty when this runs.
ALTER TABLE "change_batch" ALTER COLUMN "last_target" TYPE text COLLATE "C";
--> statement-breakpoint
-- The 0004 body plus: the execution request (POL-6) and the cancel request (EXE-7) are written
-- once; a value that is set can no longer change. Re-writing the same value is not a change.
CREATE OR REPLACE FUNCTION change_set_guard_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.operation IS DISTINCT FROM OLD.operation
     OR NEW.connection IS DISTINCT FROM OLD.connection
     OR NEW.requester IS DISTINCT FROM OLD.requester
     OR NEW.client_id IS DISTINCT FROM OLD.client_id
     OR NEW.args IS DISTINCT FROM OLD.args
     OR NEW.config_hash IS DISTINCT FROM OLD.config_hash
     OR NEW.correlation_id IS DISTINCT FROM OLD.correlation_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
    RAISE EXCEPTION 'change_set update rejected: identity columns are immutable'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  -- No way back into preparation: items could be appended again after the hash was fixed.
  IF NEW.status = 'preparing' AND OLD.status <> 'preparing' THEN
    RAISE EXCEPTION 'change_set update rejected: status cannot return to preparing'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  -- `stats` stays updatable in every status: execution outcomes recompute it (Phase 5).
  IF OLD.status <> 'preparing'
     AND (NEW.hash IS DISTINCT FROM OLD.hash OR NEW.prepared_at IS DISTINCT FROM OLD.prepared_at) THEN
    RAISE EXCEPTION 'change_set update rejected: hash is fixed once prepared'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF (OLD.execution_actor IS NOT NULL AND NEW.execution_actor IS DISTINCT FROM OLD.execution_actor)
     OR (OLD.execution_groups IS NOT NULL AND NEW.execution_groups IS DISTINCT FROM OLD.execution_groups)
     OR (OLD.execution_client_id IS NOT NULL AND NEW.execution_client_id IS DISTINCT FROM OLD.execution_client_id)
     OR (OLD.execution_correlation_id IS NOT NULL
         AND NEW.execution_correlation_id IS DISTINCT FROM OLD.execution_correlation_id)
     OR (OLD.execution_started_at IS NOT NULL AND NEW.execution_started_at IS DISTINCT FROM OLD.execution_started_at)
     OR (OLD.cancel_requested_by IS NOT NULL AND NEW.cancel_requested_by IS DISTINCT FROM OLD.cancel_requested_by)
     OR (OLD.cancel_correlation_id IS NOT NULL
         AND NEW.cancel_correlation_id IS DISTINCT FROM OLD.cancel_correlation_id)
     OR (OLD.cancel_requested_at IS NOT NULL AND NEW.cancel_requested_at IS DISTINCT FROM OLD.cancel_requested_at) THEN
    RAISE EXCEPTION 'change_set update rejected: execution request is fixed'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
-- A done batch is the durable record that its writes happened (EXE-3): it never changes again.
CREATE FUNCTION change_batch_guard_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state = 'done' THEN
    RAISE EXCEPTION 'change_batch update rejected: batch is done'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER change_batch_guard_update
  BEFORE UPDATE ON change_batch
  FOR EACH ROW EXECUTE FUNCTION change_batch_guard_update();
--> statement-breakpoint
CREATE TRIGGER change_batch_no_delete
  BEFORE DELETE ON change_batch
  FOR EACH ROW EXECUTE FUNCTION change_set_no_delete();
--> statement-breakpoint
CREATE TRIGGER change_batch_no_truncate
  BEFORE TRUNCATE ON change_batch
  FOR EACH STATEMENT EXECUTE FUNCTION change_set_no_delete();
