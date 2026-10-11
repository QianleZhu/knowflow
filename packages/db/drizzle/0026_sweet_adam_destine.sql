DELETE FROM "analytics_events" WHERE "event_type" = 'citation_clicked' OR "target_type" = 'citation';--> statement-breakpoint
UPDATE "conversation_messages"
SET "used_context" = (
	SELECT COALESCE(jsonb_agg(context_item.value - 'citationIndex' ORDER BY context_item.ordinal), '[]'::jsonb)
	FROM jsonb_array_elements("conversation_messages"."used_context") WITH ORDINALITY AS context_item(value, ordinal)
)
WHERE jsonb_typeof("used_context") = 'array';--> statement-breakpoint
UPDATE "agent_runtime_traces"
SET "retrieved_context" = (
	SELECT COALESCE(jsonb_agg(context_item.value - 'citationIndex' ORDER BY context_item.ordinal), '[]'::jsonb)
	FROM jsonb_array_elements("agent_runtime_traces"."retrieved_context") WITH ORDINALITY AS context_item(value, ordinal)
)
WHERE jsonb_typeof("retrieved_context") = 'array';--> statement-breakpoint
UPDATE "agent_runtime_trace_payloads"
SET "payload" = "payload" - 'citations'
WHERE "payload" ? 'citations';--> statement-breakpoint
DROP TABLE "message_citations" CASCADE;--> statement-breakpoint
ALTER TABLE "analytics_events" ALTER COLUMN "event_type" SET DATA TYPE text;--> statement-breakpoint
DROP TYPE "public"."analytics_event_type";--> statement-breakpoint
CREATE TYPE "public"."analytics_event_type" AS ENUM('knowledge_base_viewed', 'document_viewed', 'knowledge_item_viewed', 'knowledge_searched', 'question_asked', 'answer_generated', 'agent_called', 'feedback_submitted', 'attachment_ingestion_requested');--> statement-breakpoint
ALTER TABLE "analytics_events" ALTER COLUMN "event_type" SET DATA TYPE "public"."analytics_event_type" USING "event_type"::"public"."analytics_event_type";--> statement-breakpoint
ALTER TABLE "analytics_events" ALTER COLUMN "target_type" SET DATA TYPE text;--> statement-breakpoint
DROP TYPE "public"."analytics_target_type";--> statement-breakpoint
CREATE TYPE "public"."analytics_target_type" AS ENUM('knowledge_base', 'document', 'knowledge_item', 'agent', 'message', 'conversation', 'attachment');--> statement-breakpoint
ALTER TABLE "analytics_events" ALTER COLUMN "target_type" SET DATA TYPE "public"."analytics_target_type" USING "target_type"::"public"."analytics_target_type";--> statement-breakpoint
ALTER TABLE "agent_runtime_traces" DROP COLUMN "citations";--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN "force_citation";--> statement-breakpoint
ALTER TABLE "knowledge_items" DROP COLUMN "cite_count";--> statement-breakpoint
DROP TYPE "public"."citation_source_type";
