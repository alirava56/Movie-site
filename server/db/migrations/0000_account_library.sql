CREATE TYPE "public"."library_status" AS ENUM('watch', 'watched');--> statement-breakpoint
CREATE TYPE "public"."media_kind" AS ENUM('movie', 'series');--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" varchar(128) PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "accounts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "catalog_titles" (
	"imdb_id" varchar(14) PRIMARY KEY NOT NULL,
	"title" varchar(300) NOT NULL,
	"kind" "media_kind" NOT NULL,
	"year" smallint,
	"poster" varchar(2048) DEFAULT '' NOT NULL,
	"genre" varchar(200) DEFAULT '' NOT NULL,
	"overview" varchar(2000) DEFAULT '' NOT NULL,
	"imdb_rating" real,
	CONSTRAINT "catalog_imdb_id_format" CHECK ("catalog_titles"."imdb_id" ~ '^tt[0-9]{7,12}$'),
	CONSTRAINT "catalog_year_range" CHECK ("catalog_titles"."year" between 1000 and 9999),
	CONSTRAINT "catalog_rating_range" CHECK ("catalog_titles"."imdb_rating" between 0 and 10)
);
--> statement-breakpoint
CREATE TABLE "library_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" varchar(128) NOT NULL,
	"imdb_id" varchar(14),
	"title" varchar(300) NOT NULL,
	"search_title" text NOT NULL,
	"kind" "media_kind" NOT NULL,
	"year" smallint,
	"poster" varchar(2048) DEFAULT '' NOT NULL,
	"status" "library_status" NOT NULL,
	"my_rating" smallint,
	"watched_at" date,
	"note" varchar(16000) DEFAULT '' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"added_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "library_account_imdb_unique" UNIQUE("account_id","imdb_id"),
	CONSTRAINT "library_year_range" CHECK ("library_items"."year" between 1000 and 9999),
	CONSTRAINT "library_rating_range" CHECK ("library_items"."my_rating" between 1 and 5),
	CONSTRAINT "library_version_positive" CHECK ("library_items"."version" > 0)
);
--> statement-breakpoint
ALTER TABLE "library_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "library_request_keys" (
	"account_id" varchar(128) NOT NULL,
	"request_key" varchar(128) NOT NULL,
	"fingerprint" varchar(64) NOT NULL,
	"item_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "library_request_keys_account_id_request_key_pk" PRIMARY KEY("account_id","request_key")
);
--> statement-breakpoint
ALTER TABLE "library_request_keys" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "library_items" ADD CONSTRAINT "library_items_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_items" ADD CONSTRAINT "library_items_imdb_id_catalog_titles_imdb_id_fk" FOREIGN KEY ("imdb_id") REFERENCES "public"."catalog_titles"("imdb_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_request_keys" ADD CONSTRAINT "library_request_keys_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "library_account_recent" ON "library_items" USING btree ("account_id","added_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "library_request_age" ON "library_request_keys" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE POLICY "account_owns_row" ON "accounts" AS PERMISSIVE FOR ALL TO public USING ("accounts"."id" = nullif(current_setting('didamesh.account_id', true), '')) WITH CHECK ("accounts"."id" = nullif(current_setting('didamesh.account_id', true), ''));--> statement-breakpoint
CREATE POLICY "account_owns_row" ON "library_items" AS PERMISSIVE FOR ALL TO public USING ("library_items"."account_id" = nullif(current_setting('didamesh.account_id', true), '')) WITH CHECK ("library_items"."account_id" = nullif(current_setting('didamesh.account_id', true), ''));--> statement-breakpoint
CREATE POLICY "account_owns_row" ON "library_request_keys" AS PERMISSIVE FOR ALL TO public USING ("library_request_keys"."account_id" = nullif(current_setting('didamesh.account_id', true), '')) WITH CHECK ("library_request_keys"."account_id" = nullif(current_setting('didamesh.account_id', true), ''));--> statement-breakpoint
ALTER TABLE "accounts" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "library_items" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "library_request_keys" FORCE ROW LEVEL SECURITY;
