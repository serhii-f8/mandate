CREATE TABLE "plan" (
	"id" uuid PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"requester" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "change_set" ADD COLUMN "plan_id" uuid;--> statement-breakpoint
ALTER TABLE "change_set" ADD COLUMN "plan_step" integer;--> statement-breakpoint
ALTER TABLE "change_set" ADD CONSTRAINT "change_set_plan_id_plan_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plan"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "change_set_plan_step_idx" ON "change_set" USING btree ("plan_id","plan_step");--> statement-breakpoint
ALTER TABLE "change_set" ADD CONSTRAINT "change_set_plan_check" CHECK (("change_set"."plan_id" IS NULL AND "change_set"."plan_step" IS NULL) OR ("change_set"."plan_id" IS NOT NULL AND "change_set"."plan_step" IS NOT NULL AND "change_set"."plan_step" >= 1));
--> statement-breakpoint
-- CS-9, EXE-13 (ADR 0074): the 0016 body verbatim, plus the rule that fixes plan membership once the change-set
-- has left `preparing` or `prepared`.
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
  -- CS-4: the hash version and action are the seal of the hash and are fixed with it.
  IF OLD.status <> 'preparing'
     AND (NEW.hash IS DISTINCT FROM OLD.hash OR NEW.prepared_at IS DISTINCT FROM OLD.prepared_at
          OR NEW.hash_version IS DISTINCT FROM OLD.hash_version OR NEW.action IS DISTINCT FROM OLD.action) THEN
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
  -- EXE-12, NFR-2: the verification schedule is written once when verification begins, its end once when it
  -- finishes, so a retried activity and a continued run agree on the deadline.
  IF (OLD.verification_first_at IS NOT NULL AND NEW.verification_first_at IS DISTINCT FROM OLD.verification_first_at)
     OR (OLD.verification_until IS NOT NULL AND NEW.verification_until IS DISTINCT FROM OLD.verification_until)
     OR (OLD.verification_finished_at IS NOT NULL
         AND NEW.verification_finished_at IS DISTINCT FROM OLD.verification_finished_at) THEN
    RAISE EXCEPTION 'change_set update rejected: verification schedule is fixed'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  -- CS-9, EXE-13, CS-5 (ADR 0074): plan membership is written by createPlan (rows `prepared`) and by the derive
  -- handover (source `prepared`, new change-set `preparing`) only; once submitted or started, the order is fixed.
  IF (NEW.plan_id IS DISTINCT FROM OLD.plan_id OR NEW.plan_step IS DISTINCT FROM OLD.plan_step)
     AND OLD.status NOT IN ('preparing', 'prepared') THEN
    RAISE EXCEPTION 'change_set update rejected: plan membership changes only while preparing or prepared'
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
