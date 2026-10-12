CREATE TABLE "agent_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"user_message_id" uuid NOT NULL,
	"assistant_message_id" uuid,
	"client_request_id" uuid NOT NULL,
	"request_hash" varchar(64) NOT NULL,
	"status" varchar(24) DEFAULT 'queued' NOT NULL,
	"answer_snapshot" text DEFAULT '' NOT NULL,
	"last_sequence" integer DEFAULT 0 NOT NULL,
	"error_code" varchar(48),
	"error_message" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_user_message_id_conversation_messages_id_fk" FOREIGN KEY ("user_message_id") REFERENCES "public"."conversation_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_assistant_message_id_conversation_messages_id_fk" FOREIGN KEY ("assistant_message_id") REFERENCES "public"."conversation_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_runs_user_request_uidx" ON "agent_runs" USING btree ("user_id","client_request_id");--> statement-breakpoint
CREATE INDEX "agent_runs_conversation_created_idx" ON "agent_runs" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "agent_runs_status_updated_idx" ON "agent_runs" USING btree ("status","updated_at");--> statement-breakpoint
CREATE INDEX "agent_runs_expiry_idx" ON "agent_runs" USING btree ("expires_at");