CREATE TABLE "approval" (
	"id" uuid PRIMARY KEY NOT NULL,
	"changeset_id" uuid NOT NULL,
	"round" integer NOT NULL,
	"step" integer NOT NULL,
	"role" text NOT NULL,
	"approver" text NOT NULL,
	"approver_name" text,
	"decision" text NOT NULL,
	"comment" text,
	"hash" text NOT NULL,
	"item_count" integer NOT NULL,
	"channel" text NOT NULL,
	"auth_time" timestamp with time zone,
	"client_id" text,
	"correlation_id" text NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	CONSTRAINT "approval_changeset_round_step_key" UNIQUE("changeset_id","round","step"),
	CONSTRAINT "approval_decision_check" CHECK ("approval"."decision" IN ('approved', 'rejected', 'returned')),
	CONSTRAINT "approval_channel_check" CHECK ("approval"."channel" IN ('page', 'widget')),
	CONSTRAINT "approval_comment_length_check" CHECK (char_length("approval"."comment") <= 2000)
);
--> statement-breakpoint
ALTER TABLE "change_set" ADD COLUMN "approval_round" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "change_set" ADD COLUMN "submission" jsonb;--> statement-breakpoint
ALTER TABLE "change_set" ADD COLUMN "approval_plan" jsonb;--> statement-breakpoint
ALTER TABLE "change_set" ADD COLUMN "awaiting_role" text;--> statement-breakpoint
ALTER TABLE "approval" ADD CONSTRAINT "approval_changeset_id_change_set_id_fk" FOREIGN KEY ("changeset_id") REFERENCES "public"."change_set"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "change_set_status_awaiting_role_idx" ON "change_set" USING btree ("status","awaiting_role");

--> statement-breakpoint
-- APR-1, APR-3, POL-5 (design phase-6-approvals-decisions section 4). Messages are fixed texts:
-- they never carry column values (SEC-3).
-- The 0006 body plus the approval column rules.
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
--> statement-breakpoint
-- AUD-3: approval rows are the durable record of who decided what; they are never changed or removed.
CREATE FUNCTION approval_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'approval rows are append-only'
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER approval_no_update_delete
  BEFORE UPDATE OR DELETE ON approval
  FOR EACH ROW EXECUTE FUNCTION approval_append_only();
--> statement-breakpoint
CREATE TRIGGER approval_no_truncate
  BEFORE TRUNCATE ON approval
  FOR EACH STATEMENT EXECUTE FUNCTION approval_append_only();
