CREATE TABLE "change_batch" (
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
	CONSTRAINT "change_batch_changeset_id_batch_no_pk" PRIMARY KEY("changeset_id","batch_no"),
	CONSTRAINT "change_batch_state_check" CHECK ("change_batch"."state" IN ('open', 'done'))
);
--> statement-breakpoint
CREATE TABLE "rate_bucket" (
	"key" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer NOT NULL,
	CONSTRAINT "rate_bucket_key_window_start_pk" PRIMARY KEY("key","window_start")
);
--> statement-breakpoint
ALTER TABLE "change_set" ADD COLUMN "execution_actor" text;--> statement-breakpoint
ALTER TABLE "change_set" ADD COLUMN "execution_groups" jsonb;--> statement-breakpoint
ALTER TABLE "change_set" ADD COLUMN "execution_client_id" text;--> statement-breakpoint
ALTER TABLE "change_set" ADD COLUMN "execution_correlation_id" text;--> statement-breakpoint
ALTER TABLE "change_set" ADD COLUMN "execution_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "change_set" ADD COLUMN "cancel_requested_by" text;--> statement-breakpoint
ALTER TABLE "change_set" ADD COLUMN "cancel_correlation_id" text;--> statement-breakpoint
ALTER TABLE "change_set" ADD COLUMN "cancel_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "change_batch" ADD CONSTRAINT "change_batch_changeset_id_change_set_id_fk" FOREIGN KEY ("changeset_id") REFERENCES "public"."change_set"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "change_set_requester_status_idx" ON "change_set" USING btree ("requester","status");--> statement-breakpoint
CREATE INDEX "change_set_requester_execution_started_at_idx" ON "change_set" USING btree ("requester","execution_started_at");