CREATE TABLE "mcp_task" (
	"task_id" uuid PRIMARY KEY NOT NULL,
	"owner" text NOT NULL,
	"client_id" text,
	"changeset_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"tool" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"ttl_ms" integer NOT NULL,
	CONSTRAINT "mcp_task_kind_check" CHECK ("mcp_task"."kind" IN ('prepare', 'execute'))
);
--> statement-breakpoint
ALTER TABLE "mcp_task" ADD CONSTRAINT "mcp_task_changeset_id_change_set_id_fk" FOREIGN KEY ("changeset_id") REFERENCES "public"."change_set"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mcp_task_task_id_owner_idx" ON "mcp_task" USING btree ("task_id","owner");