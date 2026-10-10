-- 将旧列中的路径迁入父块元数据，先保留所有已有路径值。
UPDATE "parent_chunks"
SET "metadata" = jsonb_set(
  CASE
    WHEN jsonb_typeof("metadata") = 'object' THEN "metadata"
    ELSE '{}'::jsonb
  END,
  '{headingPath}',
  COALESCE("heading_path", '[]'::jsonb),
  true
);
--> statement-breakpoint
-- 路径回填完成后删除独立列，运行时统一从 metadata.headingPath 读取。
ALTER TABLE "parent_chunks" DROP COLUMN "heading_path";
