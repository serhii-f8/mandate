CREATE TABLE "config_revision" (
	"seq" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "config_revision_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"id" uuid NOT NULL,
	"hash" text NOT NULL,
	"files" jsonb NOT NULL,
	"source" text NOT NULL,
	"actor" text NOT NULL,
	"applied_at" timestamp with time zone DEFAULT now() NOT NULL,
	"summary" jsonb NOT NULL,
	CONSTRAINT "config_revision_id_unique" UNIQUE("id"),
	CONSTRAINT "config_revision_hash_check" CHECK ("config_revision"."hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "config_revision_source_check" CHECK ("config_revision"."source" IN ('apply', 'bootstrap'))
);
--> statement-breakpoint
-- CFG-4: config_revision is append-only. A configuration change is a new revision, never an edit.
CREATE FUNCTION config_revision_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'config_revision is append-only (% rejected)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER config_revision_no_update_delete
  BEFORE UPDATE OR DELETE ON config_revision
  FOR EACH ROW EXECUTE FUNCTION config_revision_append_only();
--> statement-breakpoint
CREATE TRIGGER config_revision_no_truncate
  BEFORE TRUNCATE ON config_revision
  FOR EACH STATEMENT EXECUTE FUNCTION config_revision_append_only();
