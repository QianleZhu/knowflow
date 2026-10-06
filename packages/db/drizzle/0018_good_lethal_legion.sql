DROP INDEX "child_chunks_search_vector_gin_idx";--> statement-breakpoint
DROP INDEX "knowledge_items_search_vector_gin_idx";--> statement-breakpoint
ALTER TABLE "child_chunks" DROP COLUMN "search_vector";--> statement-breakpoint
ALTER TABLE "knowledge_items" DROP COLUMN "search_vector";--> statement-breakpoint
-- 中文友好全文检索：PGroonga（TokenBigram 二元分词 + NormalizerAuto 归一化），替代对中文不友好的 tsvector('simple')
CREATE EXTENSION IF NOT EXISTS pgroonga;--> statement-breakpoint
CREATE INDEX "child_chunks_content_pgroonga_idx" ON "child_chunks" USING pgroonga ("content" pgroonga_text_full_text_search_ops_v2);