CREATE TABLE "credential" (
	"ref" text PRIMARY KEY NOT NULL,
	"scheme" text NOT NULL,
	"ciphertext" "bytea" NOT NULL,
	"nonce" "bytea" NOT NULL,
	"wrapped_key" "bytea" NOT NULL,
	"key_nonce" "bytea" NOT NULL,
	"key_version" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "web_login" (
	"state_hash" text PRIMARY KEY NOT NULL,
	"code_verifier" text NOT NULL,
	"nonce" text NOT NULL,
	"return_to" text NOT NULL,
	"fresh" boolean NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "web_session" (
	"id_hash" text PRIMARY KEY NOT NULL,
	"subject" text NOT NULL,
	"username" text,
	"client_id" text NOT NULL,
	"groups" jsonb NOT NULL,
	"auth_time" timestamp with time zone NOT NULL,
	"csrf_token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "web_session_expires_at_idx" ON "web_session" USING btree ("expires_at");