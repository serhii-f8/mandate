CREATE TABLE "audit_anchor" (
	"chain_pos" bigint PRIMARY KEY NOT NULL,
	"hash" text NOT NULL,
	"archive" text NOT NULL,
	"sha256" text NOT NULL,
	"count" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_event" ADD COLUMN "chain_pos" bigint;--> statement-breakpoint
CREATE INDEX "audit_event_actor_seq_idx" ON "audit_event" USING btree ("actor","seq");--> statement-breakpoint
CREATE INDEX "audit_event_action_seq_idx" ON "audit_event" USING btree ("action","seq");--> statement-breakpoint
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_event_chain_pos_unique" UNIQUE("chain_pos");--> statement-breakpoint
-- AUD-3, AUD-7: the 0001 body plus the seal and retention paths.
-- The sealer may fill the three chain columns of an unsealed row once, nothing else; retention may
-- delete sealed rows at or below the newest anchor. Each path needs its transaction-local setting
-- (set_config(<name>, 'on', true)). With no anchor the max() is NULL and the delete is refused.
-- TRUNCATE never passes. The 0001 triggers call this function and stay as they are.
CREATE OR REPLACE FUNCTION audit_event_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
    AND current_setting('mandate.audit_seal', true) = 'on'
    AND OLD.chain_pos IS NULL AND OLD.prev_hash IS NULL AND OLD.hash IS NULL
    AND NEW.chain_pos IS NOT NULL AND NEW.prev_hash IS NOT NULL AND NEW.hash IS NOT NULL
    AND (NEW.seq, NEW.id, NEW.ts, NEW.actor, NEW.client_id, NEW.action, NEW.subject, NEW.decision,
         NEW.outcome, NEW.correlation_id, NEW.changeset_id, NEW.details)
      IS NOT DISTINCT FROM
        (OLD.seq, OLD.id, OLD.ts, OLD.actor, OLD.client_id, OLD.action, OLD.subject, OLD.decision,
         OLD.outcome, OLD.correlation_id, OLD.changeset_id, OLD.details)
  THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE'
    AND current_setting('mandate.audit_retention', true) = 'on'
    AND OLD.chain_pos IS NOT NULL
    AND OLD.chain_pos <= (SELECT max(chain_pos) FROM audit_anchor)
  THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'audit_event is append-only (% rejected)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
--> statement-breakpoint
-- AUD-7: retention anchors are append-only. Rows can be inserted, never changed or removed.
CREATE FUNCTION audit_anchor_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_anchor is append-only (% rejected)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER audit_anchor_no_update_delete
  BEFORE UPDATE OR DELETE ON audit_anchor
  FOR EACH ROW EXECUTE FUNCTION audit_anchor_append_only();
--> statement-breakpoint
CREATE TRIGGER audit_anchor_no_truncate
  BEFORE TRUNCATE ON audit_anchor
  FOR EACH STATEMENT EXECUTE FUNCTION audit_anchor_append_only();
