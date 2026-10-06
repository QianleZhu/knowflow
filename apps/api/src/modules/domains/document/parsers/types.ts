// 文档解析与视觉 OCR 的公共类型。
import type { DocumentSourceType } from "@knowflow/shared";
import type { ParsedContentBlock } from "../document-blocks.js";

export type ParsedDocument = {
  text: string;
  // 每种生产解析器都必须提供结构块；封装清洗工具的中间结果允许暂时没有节点。
  structuredBlocks?: ParsedContentBlock[];
  metadata: {
    parser:
      | "docling"
      | "remark"
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
    ocrPageNumbers?: number[];
    blankPageNumbers?: number[];
    visionImageCount?: number;
    visionImageInsertedCount?: number;
    visionImageSkippedCount?: number;
    visionImageFailedCount?: number;
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
  prompt?: string;
};

export type VisionStats = {
  attempted: number;
  inserted: number;
  skippedDecorative: number;
  failed: number;
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
