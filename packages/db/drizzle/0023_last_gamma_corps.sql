CREATE TABLE "agent_runtime_trace_payloads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"span_id" uuid NOT NULL,
	"payload_type" varchar(80) NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_runtime_trace_spans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trace_id" uuid NOT NULL,
	"parent_span_id" uuid,
	"sequence" integer NOT NULL,
	"name" varchar(120) NOT NULL,
	"kind" varchar(40) NOT NULL,
	"status" varchar(24) DEFAULT 'running' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"duration_ms" integer,
	"model" varchar(160),
	"input_tokens" integer,
	"output_tokens" integer,
	"usage_source" varchar(24),
	"estimated_cost_cny" numeric(20, 12),
	"price_snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_runtime_traces" DROP CONSTRAINT "agent_runtime_traces_conversation_id_conversations_id_fk";
--> statement-breakpoint
ALTER TABLE "agent_runtime_traces" ADD COLUMN "user_message_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_runtime_traces" ADD COLUMN "status" varchar(24) DEFAULT 'completed' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_runtime_traces" ADD COLUMN "input_tokens" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_runtime_traces" ADD COLUMN "output_tokens" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_runtime_traces" ADD COLUMN "unknown_usage_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_runtime_traces" ADD COLUMN "estimated_cost_cny" numeric(20, 12);--> statement-breakpoint
ALTER TABLE "agent_runtime_trace_payloads" ADD CONSTRAINT "agent_runtime_trace_payloads_span_id_agent_runtime_trace_spans_id_fk" FOREIGN KEY ("span_id") REFERENCES "public"."agent_runtime_trace_spans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runtime_trace_spans" ADD CONSTRAINT "agent_runtime_trace_spans_trace_id_agent_runtime_traces_id_fk" FOREIGN KEY ("trace_id") REFERENCES "public"."agent_runtime_traces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runtime_trace_spans" ADD CONSTRAINT "agent_runtime_trace_spans_parent_span_id_agent_runtime_trace_spans_id_fk" FOREIGN KEY ("parent_span_id") REFERENCES "public"."agent_runtime_trace_spans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_runtime_trace_payloads_span_type_idx" ON "agent_runtime_trace_payloads" USING btree ("span_id","payload_type");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_runtime_trace_spans_trace_sequence_uidx" ON "agent_runtime_trace_spans" USING btree ("trace_id","sequence");--> statement-breakpoint
CREATE INDEX "agent_runtime_trace_spans_parent_idx" ON "agent_runtime_trace_spans" USING btree ("parent_span_id");--> statement-breakpoint
CREATE INDEX "agent_runtime_trace_spans_model_created_idx" ON "agent_runtime_trace_spans" USING btree ("model","created_at");--> statement-breakpoint
ALTER TABLE "agent_runtime_traces" ADD CONSTRAINT "agent_runtime_traces_user_message_id_conversation_messages_id_fk" FOREIGN KEY ("user_message_id") REFERENCES "public"."conversation_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runtime_traces" ADD CONSTRAINT "agent_runtime_traces_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_runtime_traces_conversation_created_idx" ON "agent_runtime_traces" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_runtime_traces_user_message_uidx" ON "agent_runtime_traces" USING btree ("user_message_id");