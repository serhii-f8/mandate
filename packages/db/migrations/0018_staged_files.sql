CREATE TABLE "change_set_file" (
	"change_set_id" uuid NOT NULL,
	"pointer" text NOT NULL,
	"file_id" uuid NOT NULL,
	CONSTRAINT "change_set_file_change_set_id_pointer_pk" PRIMARY KEY("change_set_id","pointer")
);
--> statement-breakpoint
CREATE TABLE "staged_file" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner" text NOT NULL,
	"client_id" text,
	"name" text NOT NULL,
	"media_type" text NOT NULL,
	"size" integer NOT NULL,
	"sha256" text NOT NULL,
	"preview" text NOT NULL,
	"content" "bytea",
	"created_at" timestamp with time zone NOT NULL,
	"purged_at" timestamp with time zone,
	CONSTRAINT "staged_file_size_check" CHECK ("staged_file"."size" > 0),
	CONSTRAINT "staged_file_preview_check" CHECK ("staged_file"."preview" IN ('image', 'text', 'none')),
	CONSTRAINT "staged_file_purged_check" CHECK (("staged_file"."content" IS NULL) = ("staged_file"."purged_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "change_set_file" ADD CONSTRAINT "change_set_file_change_set_id_change_set_id_fk" FOREIGN KEY ("change_set_id") REFERENCES "public"."change_set"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_set_file" ADD CONSTRAINT "change_set_file_file_id_staged_file_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."staged_file"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "change_set_file_file_id_idx" ON "change_set_file" USING btree ("file_id");--> statement-breakpoint
CREATE INDEX "staged_file_owner_created_at_idx" ON "staged_file" USING btree ("owner","created_at" DESC NULLS LAST);
--> statement-breakpoint
-- CS-10 (ADR 0075): a staged file is immutable except for its purge. The only UPDATE is content -> NULL together
-- with purged_at NULL -> a time; every other column stays as it was. DELETE is refused.
CREATE FUNCTION staged_file_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'staged_file delete rejected: staged files are never deleted'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.owner IS DISTINCT FROM OLD.owner
     OR NEW.client_id IS DISTINCT FROM OLD.client_id
     OR NEW.name IS DISTINCT FROM OLD.name
     OR NEW.media_type IS DISTINCT FROM OLD.media_type
     OR NEW.size IS DISTINCT FROM OLD.size
     OR NEW.sha256 IS DISTINCT FROM OLD.sha256
     OR NEW.preview IS DISTINCT FROM OLD.preview
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR OLD.content IS NULL
     OR OLD.purged_at IS NOT NULL
     OR NEW.content IS NOT NULL
     OR NEW.purged_at IS NULL THEN
    RAISE EXCEPTION 'staged_file update rejected: the only change is the purge of the content'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER staged_file_guard BEFORE UPDATE OR DELETE ON staged_file
  FOR EACH ROW EXECUTE FUNCTION staged_file_guard();
--> statement-breakpoint
-- CS-10: the links of a change-set are fixed with it.
CREATE FUNCTION change_set_file_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'change_set_file % rejected: links are insert-only', lower(TG_OP)
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER change_set_file_guard BEFORE UPDATE OR DELETE ON change_set_file
  FOR EACH ROW EXECUTE FUNCTION change_set_file_guard();
