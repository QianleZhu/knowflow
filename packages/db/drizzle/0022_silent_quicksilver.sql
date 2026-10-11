-- 删除用户可配置的模型数据、知识库嵌入模型列和 Agent 自选模型列。
DROP TABLE "model_catalog" CASCADE;--> statement-breakpoint
DROP TABLE "model_providers" CASCADE;--> statement-breakpoint
DROP TABLE "model_usage_policies" CASCADE;--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN "model_provider";--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN "model_name";--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN "model_config";--> statement-breakpoint
ALTER TABLE "knowledge_bases" DROP COLUMN "embedding_model";--> statement-breakpoint
DROP TYPE "public"."model_provider_type";--> statement-breakpoint
DROP TYPE "public"."model_type";--> statement-breakpoint
DROP TYPE "public"."model_usage_type";
