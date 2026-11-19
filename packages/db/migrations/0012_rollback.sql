CREATE TABLE "change_rollback_batch" (
	"changeset_id" uuid NOT NULL,
	"batch_no" integer NOT NULL,
	"attempt" integer NOT NULL,
	"state" text NOT NULL,
	"target_ids" jsonb NOT NULL,
	"last_target" text NOT NULL,
	"upstream_batch_id" text,
	"plan" jsonb,
	"written" integer DEFAULT 0 NOT NULL,
	"failed" integer DEFAULT 0 NOT NULL,
	"skipped" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "change_rollback_batch_changeset_id_batch_no_pk" PRIMARY KEY("changeset_id","batch_no"),
	CONSTRAINT "change_rollback_batch_state_check" CHECK ("change_rollback_batch"."state" IN ('open', 'done'))
);
--> statement-breakpoint
ALTER TABLE "notification_outbox" DROP CONSTRAINT "notification_outbox_kind_check";--> statement-breakpoint
ALTER TABLE "change_item" ADD COLUMN "rollback_status" text;--> statement-breakpoint
ALTER TABLE "change_item" ADD COLUMN "rollback_error" text;--> statement-breakpoint
ALTER TABLE "change_set" ADD COLUMN "rollback_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "change_set" ADD COLUMN "rollback_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "change_set" ADD COLUMN "rollback_actor" text;--> statement-breakpoint
ALTER TABLE "change_set" ADD COLUMN "rollback_correlation_id" text;--> statement-breakpoint
ALTER TABLE "change_set" ADD COLUMN "rollback_client_id" text;--> statement-breakpoint
ALTER TABLE "change_rollback_batch" ADD CONSTRAINT "change_rollback_batch_changeset_id_change_set_id_fk" FOREIGN KEY ("changeset_id") REFERENCES "public"."change_set"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_item" ADD CONSTRAINT "change_item_rollback_status_check" CHECK ("change_item"."rollback_status" IS NULL OR "change_item"."rollback_status" IN ('restored', 'skipped', 'failed'));--> statement-breakpoint
ALTER TABLE "notification_outbox" ADD CONSTRAINT "notification_outbox_kind_check" CHECK ("notification_outbox"."kind" IN ('approval_requested', 'approval_decided', 'execution_finished', 'rollback_result'));
--> statement-breakpoint
-- EXE-8: rollback (design phase-8-rollback-audit-rollback §3). Function bodies: 0011 (change_set) and 0004 (change_item) verbatim, plus the rollback rules.
-- Code-point order for target IDs, as in change_batch (0006). The table is empty when this runs.
ALTER TABLE "change_rollback_batch" ALTER COLUMN "last_target" TYPE text COLLATE "C";
--> statement-breakpoint
-- EXE-3: a done rollback batch never changes again; rollback batches are never deleted.
CREATE TRIGGER change_rollback_batch_guard_update
  BEFORE UPDATE ON change_rollback_batch
  FOR EACH ROW EXECUTE FUNCTION change_batch_guard_update();
--> statement-breakpoint
CREATE TRIGGER change_rollback_batch_no_delete
  BEFORE DELETE ON change_rollback_batch
  FOR EACH ROW EXECUTE FUNCTION change_set_no_delete();
--> statement-breakpoint
CREATE TRIGGER change_rollback_batch_no_truncate
  BEFORE TRUNCATE ON change_rollback_batch
  FOR EACH STATEMENT EXECUTE FUNCTION change_set_no_delete();
--> statement-breakpoint
-- EXE-8: the 0011 body plus the rollback window, request and status rules.
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
  -- EXE-8: the window is written once (by the workflow's window activity).
  IF OLD.rollback_until IS NOT NULL AND NEW.rollback_until IS DISTINCT FROM OLD.rollback_until THEN
    RAISE EXCEPTION 'change_set update rejected: rollback window is fixed'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  -- EXE-8: the rollback request is written once, together with the move into rolling_back.
  IF (NEW.rollback_requested_at IS DISTINCT FROM OLD.rollback_requested_at
      OR NEW.rollback_actor IS DISTINCT FROM OLD.rollback_actor
      OR NEW.rollback_correlation_id IS DISTINCT FROM OLD.rollback_correlation_id
      OR NEW.rollback_client_id IS DISTINCT FROM OLD.rollback_client_id)
     AND NOT (OLD.rollback_requested_at IS NULL AND OLD.rollback_actor IS NULL
              AND OLD.rollback_correlation_id IS NULL AND OLD.rollback_client_id IS NULL
              AND NEW.status = 'rolling_back' AND OLD.status <> 'rolling_back') THEN
    RAISE EXCEPTION 'change_set update rejected: rollback request is fixed'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  -- EXE-8: a finished change-set moves only into a requested rollback, once; a rollback ends rolled back or failed.
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF OLD.status IN ('completed', 'completed_with_errors', 'cancelled', 'failed', 'rolled_back')
       AND NOT (NEW.status = 'rolling_back'
                AND OLD.rollback_requested_at IS NULL
                AND NEW.rollback_requested_at IS NOT NULL
                AND NEW.rollback_actor IS NOT NULL
                AND NEW.rollback_correlation_id IS NOT NULL
                AND (OLD.status IN ('completed', 'completed_with_errors') OR OLD.execution_started_at IS NOT NULL)) THEN
      RAISE EXCEPTION 'change_set update rejected: a finished change-set moves only to a requested rollback'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF OLD.status = 'rolling_back' AND NEW.status NOT IN ('rolled_back', 'failed') THEN
      RAISE EXCEPTION 'change_set update rejected: a rollback ends only rolled back or failed'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
-- EXE-8: the 0004 body plus the item rollback outcome rule.
CREATE OR REPLACE FUNCTION change_item_guard_update() RETURNS trigger
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
  -- EXE-8: a rollback outcome is written once, only for an item this run wrote, only while rolling back.
  IF NEW.rollback_status IS DISTINCT FROM OLD.rollback_status OR NEW.rollback_error IS DISTINCT FROM OLD.rollback_error THEN
    IF OLD.rollback_status IS NOT NULL OR OLD.rollback_error IS NOT NULL THEN
      RAISE EXCEPTION 'change_item update rejected: rollback outcome is fixed'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF OLD.status <> 'written' OR OLD.error IS NOT NULL
       OR NEW.status IS DISTINCT FROM OLD.status OR NEW.error IS DISTINCT FROM OLD.error THEN
      RAISE EXCEPTION 'change_item update rejected: only items this run wrote roll back'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    SELECT status INTO parent_status FROM change_set WHERE id = NEW.changeset_id FOR SHARE;
    IF parent_status IS DISTINCT FROM 'rolling_back' THEN
      RAISE EXCEPTION 'change_item update rejected: change-set is not rolling back'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
