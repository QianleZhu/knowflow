// PDF 正文与扫描件、内嵌图片解析。
import { PDFParse } from "pdf-parse";
import { parseDoclingDocument } from "./docling.parser.js";
import type { ParsedDocument, VisionStats, VisionDescription } from "./types.js";
import { toParsedDocument } from "./cleaner.js";
import { formatPageMarker, stripPageMarkers } from "../document-text-structure.js";
import {
  newVisionStats,
  visionStatsMetadata,
  newVisionBudget,
  describeImageWithVision,
  markVisionTruncated,
  pushUniqueWarning,
  formatVisionDescriptions,
} from "./vision-ocr.js";

const PDF_SCANNED_MIN_CHARS_PER_PAGE = 40;

const PDF_SCREENSHOT_WIDTH = 1400;

// 解析 PDF 正文，按扫描件检测结果选择截图或内嵌图片 OCR。
export async function parsePdfDocument(buffer: Buffer): Promise<ParsedDocument> {
  const parser = new PDFParse({ data: buffer });
  const stats = newVisionStats();
  try {
    const result = await parser.getText({ pageJoiner: "" });
    const pageCount = Math.max(result.total, result.pages.length, 1);
    const markedText = markPdfPages(result.pages);
    const scannedPdfDetected = isScannedPdfText(markedText, pageCount);
    if (!scannedPdfDetected) return await parseDoclingDocument(buffer, "pdf");
    // 扫描件保持原截图 OCR；文字型已经进入 Docling 原位回填。
    const visualTexts = await describePdfPageScreenshots(parser, pageCount, stats);
    if (visualTexts.length === 0) {
      throw new Error("扫描件 PDF 视觉 OCR 失败，请检查 OCR 模型配置后重试");
    }
    const combinedText = buildPdfTextWithVisualDescriptions(result.pages, visualTexts);

    if (combinedText.trim().length === 0) {
      throw new Error("扫描件 PDF 无法完成图片渲染或视觉 OCR，请检查 OCR 模型配置后重试");
    }

    return await toParsedDocument(
      combinedText,
      "pdf-parse",
      {
        pdfPageCount: pageCount,
        scannedPdfDetected: true,
        ...visionStatsMetadata(stats),
      },
      "text",
    );
  } catch (error) {
    if (error instanceof Error && error.message.length > 0) {
      throw error;
    }
    throw new Error("PDF 文档解析失败，请确认文件未损坏且可读取");
  } finally {
    await parser.destroy();
  }
}

// 逐页截图执行扫描件 OCR，并限制单文档调用预算。
async function describePdfPageScreenshots(
  parser: PDFParse,
  pageCount: number,
  stats: VisionStats,
): Promise<VisionDescription[]> {
  const descriptions: VisionDescription[] = [];
  const budget = newVisionBudget();
  for (let page = 1; page <= pageCount; page += 1) {
    if (budget.used >= budget.limit) {
      markVisionTruncated(stats);
      break;
    }
    try {
      const result = await parser.getScreenshot({
        partial: [page],
        desiredWidth: PDF_SCREENSHOT_WIDTH,
        imageDataUrl: false,
        imageBuffer: true,
      });
      const screenshot = result.pages[0];
      if (screenshot === undefined) {
        stats.failed += 1;
        pushUniqueWarning(stats, "pdf_screenshot_empty");
        continue;
      }
      const text = await describeImageWithVision(
        {
          buffer: Buffer.from(screenshot.data),
          mimeType: "image/png",
          sourceLabel: `PDF 第 ${String(page)} 页`,
          width: screenshot.width,
          height: screenshot.height,
          skipDecorative: false,
        },
        budget,
        stats,
      );
      if (text !== null) {
        descriptions.push({ sourceLabel: `PDF 第 ${String(page)} 页`, text, pageNumber: page });
      }
    } catch (error) {
      stats.failed += 1;
      pushUniqueWarning(stats, "pdf_screenshot_failed");
      console.warn("PDF 页面渲染失败，已跳过该页视觉解析", {
        page,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return descriptions;
}

// 为 PDF 正文插入内部页码标记。
function markPdfPages(pages: { num: number; text: string }[]): string {
  return buildPdfTextWithVisualDescriptions(pages, []);
}

// 按页合并 PDF 正文与图片描述。
export function buildPdfTextWithVisualDescriptions(
  pages: { num: number; text: string }[],
  descriptions: VisionDescription[],
): string {
  const descriptionsByPage = new Map<number, VisionDescription[]>();
  const unpagedDescriptions: VisionDescription[] = [];
  for (const description of descriptions) {
    if (description.pageNumber === null) {
      unpagedDescriptions.push(description);
      continue;
    }
    const current = descriptionsByPage.get(description.pageNumber) ?? [];
    current.push(description);
    descriptionsByPage.set(description.pageNumber, current);
  }

  const parts = [...pages]
    .sort((left, right) => left.num - right.num)
    .map((page) => {
      const pageDescriptions = descriptionsByPage.get(page.num) ?? [];
      return [formatPageMarker(page.num), page.text, formatVisionDescriptions(pageDescriptions)]
        .filter((part) => part.trim().length > 0)
        .join("\n\n");
    });
  if (unpagedDescriptions.length > 0) {
    parts.push(formatVisionDescriptions(unpagedDescriptions));
  }
  return parts.filter((part) => part.trim().length > 0).join("\n\n");
}

// 根据每页平均有效文字数检测扫描件。
export function isScannedPdfText(text: string, pageCount: number): boolean {
  const contentChars = stripPageMarkers(text).replace(/\s/g, "").length;
  return contentChars < pageCount * PDF_SCANNED_MIN_CHARS_PER_PAGE;
}
