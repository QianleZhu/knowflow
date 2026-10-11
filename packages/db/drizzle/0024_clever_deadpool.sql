ALTER TABLE "agent_runtime_traces" DROP CONSTRAINT "agent_runtime_traces_user_message_id_conversation_messages_id_fk";
--> statement-breakpoint
ALTER TABLE "agent_runtime_traces" ADD CONSTRAINT "agent_runtime_traces_user_message_id_conversation_messages_id_fk" FOREIGN KEY ("user_message_id") REFERENCES "public"."conversation_messages"("id") ON DELETE set null ON UPDATE no action;