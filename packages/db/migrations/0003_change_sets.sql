CREATE TABLE "change_item" (
	"changeset_id" uuid NOT NULL,
	"target_id" text NOT NULL,
	"status" text NOT NULL,
	"reason" text,
	"before" jsonb NOT NULL,
	"after" jsonb NOT NULL,
	"error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "change_item_changeset_id_target_id_pk" PRIMARY KEY("changeset_id","target_id"),
	CONSTRAINT "change_item_status_check" CHECK ("change_item"."status" IN ('pending', 'excluded', 'written', 'failed', 'skipped'))
);
--> statement-breakpoint
CREATE TABLE "change_set" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operation" text NOT NULL,
	"connection" text NOT NULL,
	"requester" text NOT NULL,
	"client_id" text,
	"args" jsonb NOT NULL,
	"hash" text,
	"status" text NOT NULL,
	"stats" jsonb NOT NULL,
	"error_code" text,
	"config_hash" text NOT NULL,
	"correlation_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"prepared_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "change_set_status_check" CHECK ("change_set"."status" IN ('preparing', 'prepared', 'pending_approval', 'approved', 'executing', 'completed', 'completed_with_errors', 'failed', 'rejected', 'expired', 'cancelled', 'rolling_back', 'rolled_back'))
);
--> statement-breakpoint
ALTER TABLE "change_item" ADD CONSTRAINT "change_item_changeset_id_change_set_id_fk" FOREIGN KEY ("changeset_id") REFERENCES "public"."change_set"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "change_set_requester_created_at_idx" ON "change_set" USING btree ("requester","created_at");