// 文档解析与视觉 OCR 的公共类型。
import type { DocumentSourceType } from "@knowflow/shared";
import type { ParsedContentBlock } from "../document-blocks.js";

export type ParsedDocument = {
  text: string;
  // Docling 格式额外保留顺序、标题层级和来源页码；其他解析器继续使用 Markdown 兜底。
  structuredBlocks?: ParsedContentBlock[];
  metadata: {
    parser:
      | "docling"
      | "pdf-parse"
      | "@pdf2md/core"
      | "word-to-markdown"
      | "plain-text"
      | "mammoth"
      | "csv-parse"
      | "read-excel-file"
      | "@e965/xlsx"
      | "vision-ocr";
    parsedAt: string;
    textLength: number;
    originalFormat?: "docx";
    sheetCount?: number;
    rowCount?: number;
    mimeType?: string;
    rawTextLength: number;
    cleanedTextLength: number;
    cleanerVersion: string;
    cleaningWarnings: string[];
    contentFormat: "markdown";
    markdownDialect: "gfm";
    parserWarnings?: string[];
    pageInfoUnavailable?: true;
    pdfPageCount?: number;
    scannedPdfDetected?: true;
    visionImageLimit?: number;
    visionImageCount?: number;
    visionImageInsertedCount?: number;
    visionImageSkippedCount?: number;
    visionImageFailedCount?: number;
    visionImageTruncated?: true;
    multimodalWarnings?: string[];
  };
};

export type ParsedDocumentExtraMetadata = Partial<
  Omit<
    ParsedDocument["metadata"],
    | "parser"
    | "parsedAt"
    | "textLength"
    | "rawTextLength"
    | "cleanedTextLength"
    | "cleanerVersion"
    | "cleaningWarnings"
    | "pageInfoUnavailable"
    | "contentFormat"
    | "markdownDialect"
  >
>;

export type VisionImageInput = {
  buffer: Buffer;
  mimeType: string;
  sourceLabel: string;
  width: number | null;
  height: number | null;
  skipDecorative: boolean;
};

export type VisionBudget = {
  limit: number;
  used: number;
};

export type VisionStats = {
  attempted: number;
  inserted: number;
  skippedDecorative: number;
  failed: number;
  truncated: boolean;
  warnings: string[];
};

export type VisionDescription = {
  sourceLabel: string;
  text: string;
  pageNumber: number | null;
};

// 解析器仅接收文件内容和必要的文档上下文，不访问数据库或存储。
export type ParserContext = {
  sourceType: DocumentSourceType;
  mimeType: string | null;
  documentId: string;
  title: string;
};
