CREATE TABLE "notification_outbox" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"changeset_id" uuid NOT NULL,
	"round" integer NOT NULL,
	"step" integer NOT NULL,
	"target" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone NOT NULL,
	"sent_at" timestamp with time zone,
	CONSTRAINT "notification_outbox_kind_check" CHECK ("notification_outbox"."kind" IN ('approval_requested', 'approval_decided', 'execution_finished')),
	CONSTRAINT "notification_outbox_state_check" CHECK ("notification_outbox"."state" IN ('pending', 'sent', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "notification_outbox" ADD CONSTRAINT "notification_outbox_changeset_id_change_set_id_fk" FOREIGN KEY ("changeset_id") REFERENCES "public"."change_set"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "notification_outbox_producer_key" ON "notification_outbox" USING btree ("changeset_id","kind","round","step","target");--> statement-breakpoint
CREATE INDEX "notification_outbox_due_idx" ON "notification_outbox" USING btree ("next_attempt_at") WHERE "notification_outbox"."state" = 'pending';