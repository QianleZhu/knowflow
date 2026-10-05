// 共享视觉 OCR 预算、统计与装饰图过滤。
import { callModelByUsage } from "../../../../shared/llm/model-usage-client.js";
import type {
  VisionImageInput,
  VisionBudget,
  VisionStats,
  VisionDescription,
  ParsedDocumentExtraMetadata,
} from "./types.js";

const MAX_VISION_IMAGES_PER_DOCUMENT = 20;

const DECORATIVE_IMAGE_MIN_LONG_EDGE = 120;

const DECORATIVE_IMAGE_MIN_AREA = 10000;

const VISION_IMAGE_PROMPT =
  "图中若主要是文字/表格，转写为 markdown（表格务必保留为 markdown 表格）；若是照片/图表/示意图，用一段简洁中文描述其内容与关键信息。";

// 过滤装饰图并在单文档预算内调用视觉模型。
export async function describeImageWithVision(
  image: VisionImageInput,
  budget: VisionBudget,
  stats: VisionStats,
): Promise<string | null> {
  if (image.skipDecorative && isDecorativeImage(image.width, image.height)) {
    stats.skippedDecorative += 1;
    return null;
  }
  if (budget.used >= budget.limit) {
    markVisionTruncated(stats);
    return null;
  }

  budget.used += 1;
  stats.attempted += 1;
  try {
    const text = (
      await callModelByUsage(
        "ocr",
        [
          {
            role: "user",
            content: [
              { type: "text", text: VISION_IMAGE_PROMPT },
              {
                type: "image_url",
                image_url: {
                  url: `data:${image.mimeType};base64,${image.buffer.toString("base64")}`,
                },
              },
            ],
          },
        ],
        { temperature: 0, maxOutputTokens: 4000 },
      )
    ).trim();
    if (text.length === 0) {
      stats.failed += 1;
      pushUniqueWarning(stats, "vision_empty_response");
      return null;
    }
    stats.inserted += 1;
    return text;
  } catch (error) {
    stats.failed += 1;
    pushUniqueWarning(stats, "vision_call_failed");
    console.warn("视觉 OCR 调用失败，已跳过该图片", {
      sourceLabel: image.sourceLabel,
      message: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

// 初始化单文档视觉调用预算。
export function newVisionBudget(): VisionBudget {
  return { limit: MAX_VISION_IMAGES_PER_DOCUMENT, used: 0 };
}

// 初始化视觉解析计数与告警。
export function newVisionStats(): VisionStats {
  return {
    attempted: 0,
    inserted: 0,
    skippedDecorative: 0,
    failed: 0,
    truncated: false,
    warnings: [],
  };
}

// 将视觉统计转换为文档解析元数据。
export function visionStatsMetadata(stats: VisionStats): ParsedDocumentExtraMetadata {
  return {
    visionImageLimit: MAX_VISION_IMAGES_PER_DOCUMENT,
    visionImageCount: stats.attempted,
    visionImageInsertedCount: stats.inserted,
    visionImageSkippedCount: stats.skippedDecorative,
    visionImageFailedCount: stats.failed,
    ...(stats.truncated ? { visionImageTruncated: true as const } : {}),
    ...(stats.warnings.length > 0 ? { multimodalWarnings: stats.warnings } : {}),
  };
}

// 记录视觉预算耗尽及截断告警。
export function markVisionTruncated(stats: VisionStats): void {
  if (!stats.truncated) {
    stats.truncated = true;
    pushUniqueWarning(stats, "vision_image_limit_reached");
    console.warn("文档图片数量超过视觉 OCR 调用上限，后续图片已截断", {
      limit: MAX_VISION_IMAGES_PER_DOCUMENT,
    });
  }
}

// 去重记录解析告警。
export function pushUniqueWarning(stats: VisionStats, warning: string): void {
  if (!stats.warnings.includes(warning)) {
    stats.warnings.push(warning);
  }
}

// 根据长边和面积识别装饰图片。
export function isDecorativeImage(width: number | null, height: number | null): boolean {
  if (width === null || height === null) {
    return false;
  }
  const longEdge = Math.max(width, height);
  const area = width * height;
  return longEdge < DECORATIVE_IMAGE_MIN_LONG_EDGE || area < DECORATIVE_IMAGE_MIN_AREA;
}

// 将视觉描述格式化为正文段落。
export function formatVisionDescriptions(descriptions: VisionDescription[]): string {
  return descriptions
    .map((description) => `## ${description.sourceLabel}\n\n${description.text}`)
    .join("\n\n");
}
