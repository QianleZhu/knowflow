// 整图视觉 OCR 解析。
import type { ParsedDocument, ParserContext } from "./types.js";
import { toParsedDocument } from "./cleaner.js";
import {
  describeImageWithVision,
  newVisionStats,
  newVisionBudget,
  visionStatsMetadata,
} from "./vision-ocr.js";

// 将整图作为正文执行视觉 OCR，失败时拒绝生成空文档。
export async function parseImageDocument(
  buffer: Buffer,
  context: ParserContext,
): Promise<ParsedDocument> {
  const stats = newVisionStats();
  const mimeType = context.mimeType ?? "image/png";
  const text = await describeImageWithVision(
    {
      buffer,
      mimeType,
      sourceLabel: "图片文档",
      width: null,
      height: null,
      skipDecorative: false,
    },
    newVisionBudget(),
    stats,
  );
  if (text === null) {
    throw new Error("图片文档视觉 OCR 失败，请检查 OCR 模型配置后重试");
  }

  return toParsedDocument(text, "vision-ocr", { mimeType, ...visionStatsMetadata(stats) });
}
