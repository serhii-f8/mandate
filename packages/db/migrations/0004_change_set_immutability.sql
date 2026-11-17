-- CS-4: change-sets are immutable after `prepared` (design phase-4-changesets section 5.1).
-- Messages are fixed texts: they never carry column values (SEC-3).

-- Code-point order for target IDs, the same order as core's compareTargetIds (UTF-8 bytes
-- sort like code points). The table is empty when this runs.
ALTER TABLE "change_item" ALTER COLUMN "target_id" TYPE text COLLATE "C";
--> statement-breakpoint
-- A change-set that reached `prepared` always carries its hash; only rows that never got
-- there (preparing, or failed, cancelled, expired) may lack one.
ALTER TABLE "change_set" ADD CONSTRAINT "change_set_hash_when_prepared" CHECK (
  "hash" IS NOT NULL OR "status" NOT IN (
    'prepared', 'pending_approval', 'approved', 'executing', 'completed',
    'completed_with_errors', 'rolling_back', 'rolled_back'
  )
);
--> statement-breakpoint
CREATE FUNCTION change_item_guard_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  parent_status text;
BEGIN
  -- FOR SHARE: a concurrent status change of the parent waits until this insert commits.
  SELECT status INTO parent_status FROM change_set WHERE id = NEW.changeset_id FOR SHARE;
  IF parent_status IS DISTINCT FROM 'preparing' THEN
    RAISE EXCEPTION 'change_item insert rejected: change-set is not preparing'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION change_item_guard_update() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  parent_status text;
BEGIN
  IF NEW.changeset_id IS DISTINCT FROM OLD.changeset_id
     OR NEW.target_id IS DISTINCT FROM OLD.target_id
     OR NEW.before IS DISTINCT FROM OLD.before
     OR NEW.after IS DISTINCT FROM OLD.after
     OR NEW.reason IS DISTINCT FROM OLD.reason THEN
    RAISE EXCEPTION 'change_item update rejected: item content is immutable'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF (OLD.status = 'excluded') <> (NEW.status = 'excluded') THEN
    RAISE EXCEPTION 'change_item update rejected: exclusion is immutable'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  -- Item statuses are hashed content: execution columns change only while executing or rolling back.
  IF NEW.status IS DISTINCT FROM OLD.status OR NEW.error IS DISTINCT FROM OLD.error THEN
    SELECT status INTO parent_status FROM change_set WHERE id = NEW.changeset_id FOR SHARE;
    IF parent_status IS NULL OR parent_status NOT IN ('executing', 'rolling_back') THEN
      RAISE EXCEPTION 'change_item update rejected: change-set is not executing'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION change_set_guard_update() RETURNS trigger
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
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION change_set_no_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% rejected: change-sets and their items are never deleted', TG_OP
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER change_item_guard_insert
  BEFORE INSERT ON change_item
  FOR EACH ROW EXECUTE FUNCTION change_item_guard_insert();
--> statement-breakpoint
CREATE TRIGGER change_item_guard_update
  BEFORE UPDATE ON change_item
  FOR EACH ROW EXECUTE FUNCTION change_item_guard_update();
--> statement-breakpoint
CREATE TRIGGER change_item_no_delete
  BEFORE DELETE ON change_item
  FOR EACH ROW EXECUTE FUNCTION change_set_no_delete();
--> statement-breakpoint
CREATE TRIGGER change_item_no_truncate
  BEFORE TRUNCATE ON change_item
  FOR EACH STATEMENT EXECUTE FUNCTION change_set_no_delete();
--> statement-breakpoint
CREATE TRIGGER change_set_guard_update
  BEFORE UPDATE ON change_set
  FOR EACH ROW EXECUTE FUNCTION change_set_guard_update();
--> statement-breakpoint
CREATE TRIGGER change_set_no_delete
  BEFORE DELETE ON change_set
  FOR EACH ROW EXECUTE FUNCTION change_set_no_delete();
--> statement-breakpoint
CREATE TRIGGER change_set_no_truncate
  BEFORE TRUNCATE ON change_set
  FOR EACH STATEMENT EXECUTE FUNCTION change_set_no_delete();
