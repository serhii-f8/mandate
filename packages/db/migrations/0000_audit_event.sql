CREATE TABLE "audit_event" (
	"seq" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "audit_event_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"id" uuid NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"actor" text NOT NULL,
	"client_id" text,
	"action" text NOT NULL,
	"subject" text,
	"decision" text,
	"outcome" text NOT NULL,
	"correlation_id" text NOT NULL,
	"changeset_id" uuid,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"prev_hash" text,
	"hash" text,
	CONSTRAINT "audit_event_id_unique" UNIQUE("id")
);
--> statement-breakpoint
CREATE INDEX "audit_event_ts_idx" ON "audit_event" USING btree ("ts");--> statement-breakpoint
CREATE INDEX "audit_event_correlation_id_idx" ON "audit_event" USING btree ("correlation_id");--> statement-breakpoint
CREATE INDEX "audit_event_changeset_id_idx" ON "audit_event" USING btree ("changeset_id");