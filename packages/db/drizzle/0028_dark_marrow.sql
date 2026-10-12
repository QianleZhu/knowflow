ALTER TABLE "agent_runs" ADD COLUMN "checkpoint_sequence" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
UPDATE "agent_runs" SET "checkpoint_sequence" = "last_sequence";
