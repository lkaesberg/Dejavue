CREATE TABLE "purchase_intent" (
	"user_id" text NOT NULL,
	"sku_id" text NOT NULL,
	"guild_id" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "purchase_intent_user_id_sku_id_pk" PRIMARY KEY("user_id","sku_id")
);
