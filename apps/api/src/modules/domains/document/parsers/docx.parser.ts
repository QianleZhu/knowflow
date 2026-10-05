// DOCX 正文、表格与图片解析。
import mammoth from "mammoth";
import type { ParsedDocument, VisionImageInput, VisionStats } from "./types.js";
import { toParsedDocument } from "./cleaner.js";
import { readImageDimensions } from "./image-dimensions.js";
import {
  newVisionStats,
  visionStatsMetadata,
  newVisionBudget,
  describeImageWithVision,
  formatVisionDescriptions,
} from "./vision-ocr.js";

type CapturedDocxImage = VisionImageInput & {
  placeholder: string;
};

// 提取 DOCX 正文并将内嵌图片占位符替换为视觉描述。
export async function parseDocxDocument(buffer: Buffer): Promise<ParsedDocument> {
  const stats = newVisionStats();
  const images: CapturedDocxImage[] = [];
  let nextImageIndex = 0;
  const result = await mammoth.convertToHtml(
    { buffer },
    {
      convertImage: mammoth.images.imgElement(async (image) => {
        nextImageIndex += 1;
        const placeholder = `[[KNOWFLOW_DOCX_IMAGE:${String(nextImageIndex)}]]`;
        const imageBuffer = await image.readAsBuffer();
        images.push({
          placeholder,
          buffer: imageBuffer,
          mimeType: image.contentType,
          sourceLabel: `DOCX 图片 ${String(nextImageIndex)}`,
          ...readImageDimensions(imageBuffer),
          skipDecorative: true,
        });
        return { src: placeholder };
      }),
    },
  );
  const text = await replaceDocxImagePlaceholders(htmlToMarkdownText(result.value), images, stats);
  return toParsedDocument(text, "mammoth", {
    originalFormat: "docx",
    ...visionStatsMetadata(stats),
  });
}

// 按图片顺序替换 DOCX 占位符并共享单文档预算。
async function replaceDocxImagePlaceholders(
  text: string,
  images: CapturedDocxImage[],
  stats: VisionStats,
): Promise<string> {
  let output = text;
  const budget = newVisionBudget();
  for (const image of images) {
    const description = await describeImageWithVision(image, budget, stats);
    output = output.replace(
      image.placeholder,
      description === null
        ? ""
        : formatVisionDescriptions([
            { sourceLabel: image.sourceLabel, text: description, pageNumber: null },
          ]),
    );
  }
  return output;
}

// 将 DOCX 的 HTML 转为保留标题、表格与图片占位符的文本。
export function htmlToMarkdownText(html: string): string {
  return html
    .replace(/<img\b[^>]*\bsrc="([^"]+)"[^>]*>/gi, "\n\n$1\n\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/h([1-6])>/gi, "\n\n")
    .replace(/<h([1-6])[^>]*>/gi, (_match, level: string) => `${"#".repeat(Number(level))} `)
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<\/li>/gi, "\n")
    .replace(/<\/tr>/gi, "\n")
    .replace(/<\/t[dh]>/gi, " | ")
    .replace(/<t[dh][^>]*>/gi, "| ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
