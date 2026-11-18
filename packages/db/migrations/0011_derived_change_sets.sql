ALTER TABLE "change_set" ADD COLUMN "derived_from" uuid;--> statement-breakpoint
ALTER TABLE "change_set" ADD CONSTRAINT "change_set_derived_from_change_set_id_fk" FOREIGN KEY ("derived_from") REFERENCES "public"."change_set"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
-- CS-5: the 0009 body plus derived_from among the identity columns.
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
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
     OR NEW.derived_from IS DISTINCT FROM OLD.derived_from THEN
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
  -- APR-1, POL-5: round, submission and plan are written only by the submission, which leaves
  -- `prepared` (to `pending_approval`, or to `executing` without approval).
  IF (NEW.approval_round IS DISTINCT FROM OLD.approval_round
      OR NEW.submission IS DISTINCT FROM OLD.submission
      OR NEW.approval_plan IS DISTINCT FROM OLD.approval_plan)
     AND NOT (OLD.status = 'prepared' AND NEW.status <> 'prepared') THEN
    RAISE EXCEPTION 'change_set update rejected: approval columns change only on submission'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  -- APR-3: the awaited role moves with the submission and the decisions only.
  IF NEW.awaiting_role IS DISTINCT FROM OLD.awaiting_role
     AND OLD.status NOT IN ('prepared', 'pending_approval') THEN
    RAISE EXCEPTION 'change_set update rejected: awaiting_role changes only while awaiting approval'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;
