// 文档格式能力注册表：统一上传格式、内容校验与解析入口。
import type { DocumentSourceType } from "@knowflow/shared";
import { imageSize } from "image-size";
import type { ParsedDocument, ParserContext } from "./types.js";

export type DocumentUploadKind = {
  sourceType: Extract<
    DocumentSourceType,
    "pdf" | "markdown" | "txt" | "docx" | "csv" | "excel" | "image"
  >;
  extension:
    | ".pdf"
    | ".md"
    | ".txt"
    | ".docx"
    | ".csv"
    | ".xlsx"
    | ".xls"
    | ".png"
    | ".jpg"
    | ".jpeg"
    | ".webp";
};

type DocumentCapability = DocumentUploadKind & {
  extensions: readonly string[];
  mimeTypes: readonly string[];
  magic: (buffer: Buffer) => boolean;
  parse: (buffer: Buffer, context: ParserContext) => Promise<ParsedDocument>;
};

// 每种具体文件格式在此声明一次，供上传校验和处理流水线共用。
export const DOCUMENT_CAPABILITIES: readonly DocumentCapability[] = [
  {
    sourceType: "pdf",
    extension: ".pdf",
    extensions: [".pdf"],
    mimeTypes: ["application/pdf"],
    // 按格式规则验证上传内容。
    magic: (buffer) => startsWithAscii(buffer, "%PDF-"),
    // 延迟加载具体解析器，上传请求不加载解析运行时。
    parse: async (buffer) => (await import("./pdf.parser.js")).parsePdfDocument(buffer),
  },
  {
    sourceType: "markdown",
    extension: ".md",
    extensions: [".md", ".markdown"],
    mimeTypes: ["text/markdown"],
    // 按格式规则验证上传内容。
    magic: (buffer) => isLikelyText(buffer),
    // 延迟加载具体解析器，上传请求不加载解析运行时。
    parse: async (buffer) => (await import("./text.parser.js")).parseTextDocument(buffer),
  },
  {
    sourceType: "txt",
    extension: ".txt",
    extensions: [".txt"],
    mimeTypes: ["text/plain"],
    // 按格式规则验证上传内容。
    magic: (buffer) => isLikelyText(buffer),
    // 延迟加载具体解析器，上传请求不加载解析运行时。
    parse: async (buffer) => (await import("./text.parser.js")).parseTextDocument(buffer),
  },
  {
    sourceType: "docx",
    extension: ".docx",
    extensions: [".docx"],
    mimeTypes: ["application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
    // 按格式规则验证上传内容。
    magic: (buffer) => hasZipSignature(buffer) && bufferIncludesAscii(buffer, "word/"),
    // 延迟加载具体解析器，上传请求不加载解析运行时。
    parse: async (buffer) => (await import("./docx.parser.js")).parseDocxDocument(buffer),
  },
  {
    sourceType: "csv",
    extension: ".csv",
    extensions: [".csv"],
    mimeTypes: ["text/csv"],
    // 按格式规则验证上传内容。
    magic: (buffer) => isLikelyText(buffer),
    // 延迟加载具体解析器，上传请求不加载解析运行时。
    parse: async (buffer) =>
      (await import("./spreadsheet.parser.js")).parseCsvExcelDocument(buffer, "csv"),
  },
  {
    sourceType: "excel",
    extension: ".xlsx",
    extensions: [".xlsx"],
    mimeTypes: ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
    // 按格式规则验证上传内容。
    magic: (buffer) => hasExcelSignature(buffer, ".xlsx"),
    // 延迟加载具体解析器，上传请求不加载解析运行时。
    parse: async (buffer) =>
      (await import("./spreadsheet.parser.js")).parseCsvExcelDocument(buffer, "excel"),
  },
  {
    sourceType: "excel",
    extension: ".xls",
    extensions: [".xls"],
    mimeTypes: ["application/vnd.ms-excel"],
    // 按格式规则验证上传内容。
    magic: (buffer) => hasExcelSignature(buffer, ".xls"),
    // 延迟加载具体解析器，上传请求不加载解析运行时。
    parse: async (buffer) =>
      (await import("./spreadsheet.parser.js")).parseCsvExcelDocument(buffer, "excel"),
  },
  {
    sourceType: "image",
    extension: ".png",
    extensions: [".png"],
    mimeTypes: ["image/png"],
    // 按格式规则验证上传内容。
    magic: (buffer) => hasImageType(buffer, "png"),
    // 延迟加载具体解析器，上传请求不加载解析运行时。
    parse: async (buffer, context) =>
      (await import("./image.parser.js")).parseImageDocument(buffer, context),
  },
  {
    sourceType: "image",
    extension: ".jpg",
    extensions: [".jpg"],
    mimeTypes: ["image/jpeg"],
    // 按格式规则验证上传内容。
    magic: (buffer) => hasImageType(buffer, "jpg"),
    // 延迟加载具体解析器，上传请求不加载解析运行时。
    parse: async (buffer, context) =>
      (await import("./image.parser.js")).parseImageDocument(buffer, context),
  },
  {
    sourceType: "image",
    extension: ".jpeg",
    extensions: [".jpeg"],
    mimeTypes: ["image/jpeg"],
    // 按格式规则验证上传内容。
    magic: (buffer) => hasImageType(buffer, "jpg"),
    // 延迟加载具体解析器，上传请求不加载解析运行时。
    parse: async (buffer, context) =>
      (await import("./image.parser.js")).parseImageDocument(buffer, context),
  },
  {
    sourceType: "image",
    extension: ".webp",
    extensions: [".webp"],
    mimeTypes: ["image/webp"],
    // 按格式规则验证上传内容。
    magic: (buffer) => hasImageType(buffer, "webp"),
    // 延迟加载具体解析器，上传请求不加载解析运行时。
    parse: async (buffer, context) =>
      (await import("./image.parser.js")).parseImageDocument(buffer, context),
  },
];

// 按来源类型和 MIME 选择解析器，历史缺失 MIME 的文档使用该类型默认入口。
export async function parseDocumentBuffer(
  buffer: Buffer,
  context: ParserContext,
): Promise<ParsedDocument> {
  const candidates = DOCUMENT_CAPABILITIES.filter((rule) => rule.sourceType === context.sourceType);
  const capability =
    candidates.find(
      (rule) => context.mimeType !== null && rule.mimeTypes.includes(context.mimeType),
    ) ?? candidates[0];
  if (capability === undefined) throw new Error(`不支持的文档来源类型：${context.sourceType}`);
  return capability.parse(buffer, context);
}

// 图片格式识别由 image-size 负责，并继续限制为允许上传的 PNG、JPEG 与 WebP。
function hasImageType(buffer: Buffer, expectedType: string): boolean {
  try {
    return imageSize(buffer).type === expectedType;
  } catch {
    return false;
  }
}

// 确认文件起始字节与指定 ASCII 魔数一致。
function startsWithAscii(buffer: Buffer, prefix: string): boolean {
  return buffer.subarray(0, prefix.length).equals(Buffer.from(prefix, "ascii"));
}

// 检查容器内是否包含要求的 ASCII 路径或标识。
function bufferIncludesAscii(buffer: Buffer, value: string): boolean {
  return buffer.includes(Buffer.from(value, "ascii"));
}

// 检查 Office Open XML 使用的 ZIP 容器签名。
function hasZipSignature(buffer: Buffer): boolean {
  if (buffer.length < 4) {
    return false;
  }
  const first = buffer[0];
  const second = buffer[1];
  const third = buffer[2];
  const fourth = buffer[3];
  return (
    first === 0x50 &&
    second === 0x4b &&
    third !== undefined &&
    fourth !== undefined &&
    (third === 0x03 || third === 0x05 || third === 0x07) &&
    (fourth === 0x04 || fourth === 0x06 || fourth === 0x08)
  );
}

// 分别校验现代 Excel 的 ZIP 工作表路径和旧版 Excel 的 OLE 工作簿流。
function hasExcelSignature(buffer: Buffer, extension: string): boolean {
  if (extension === ".xlsx") {
    return hasZipSignature(buffer) && bufferIncludesAscii(buffer, "xl/");
  }
  if (extension === ".xls") {
    return hasOleCompoundSignature(buffer) && hasExcelWorkbookStreamName(buffer);
  }
  return false;
}

// 检查旧版 Office 文件使用的 OLE 复合文档签名。
function hasOleCompoundSignature(buffer: Buffer): boolean {
  return buffer
    .subarray(0, 8)
    .equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));
}

// 确认 OLE 容器中存在 Excel 工作簿流标识。
function hasExcelWorkbookStreamName(buffer: Buffer): boolean {
  return (
    buffer.includes(Buffer.from("Workbook", "utf16le")) ||
    buffer.includes(Buffer.from("Book", "utf16le"))
  );
}

// 沿用非空且不含空字节的文本上传校验规则。
function isLikelyText(buffer: Buffer): boolean {
  if (buffer.length === 0) {
    return false;
  }
  return !buffer.includes(0x00);
}
