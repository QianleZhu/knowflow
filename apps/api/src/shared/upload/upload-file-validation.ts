// 上传与批量导入共用文档格式注册表，大小与权限仍由原有调用层控制。
import path from "node:path";
import {
  DOCUMENT_CAPABILITIES,
  type DocumentUploadKind,
} from "../../modules/domains/document/parsers/registry.js";
export type { DocumentUploadKind } from "../../modules/domains/document/parsers/registry.js";

export const MAX_DOCUMENT_UPLOAD_BYTES = 10 * 1024 * 1024;
export const MAX_BATCH_IMPORT_BYTES = 10 * 1024 * 1024;
type FileMetadata = {
  originalname: string;
  mimetype: string;
};
type FileWithBuffer = FileMetadata & {
  buffer: Buffer;
};
export type BatchImportKind = "csv" | "excel";

// 按扩展名和 MIME 同时匹配允许的上传格式。
export function detectDocumentUploadKind(file: FileMetadata): DocumentUploadKind | null {
  const extension = normalizedExtension(file.originalname);
  const rule = DOCUMENT_CAPABILITIES.find(
    (candidate) =>
      candidate.extensions.includes(extension) && candidate.mimeTypes.includes(file.mimetype),
  );
  return rule === undefined ? null : { sourceType: rule.sourceType, extension: rule.extension };
}

// 批量导入仅接受注册表中的 CSV 与 Excel 格式。
export function detectBatchImportKind(file: FileMetadata): BatchImportKind | null {
  const kind = detectDocumentUploadKind(file)?.sourceType;
  return kind === "csv" || kind === "excel" ? kind : null;
}

//魔数级校验:校验文件格式规定的固定字节特征判断字节类型,但是也可以篡改.整个过程很多步骤如果要完整校验安全的话
// 委托格式能力执行内容校验，拒绝不存在的格式组合。
export function validateDocumentUploadContent(
  file: FileWithBuffer,
  kind: DocumentUploadKind,
): boolean {
  const capability = DOCUMENT_CAPABILITIES.find(
    (rule) => rule.sourceType === kind.sourceType && rule.extension === kind.extension,
  );
  return capability?.magic(file.buffer) ?? false;
}

// 复用同一内容校验规则，保证批量导入与文档上传一致。
export function validateBatchImportContent(file: FileWithBuffer, kind: BatchImportKind): boolean {
  // 此入口只检查内容，扩展名和 MIME 的一致性仍由格式检测入口负责。
  const capability = DOCUMENT_CAPABILITIES.find(
    (rule) =>
      rule.sourceType === kind &&
      (kind === "csv" || rule.extension === normalizedExtension(file.originalname)),
  );
  return capability?.magic(file.buffer) ?? false;
}

// 将文件扩展名规范化为小写。
function normalizedExtension(filename: string): string {
  return path.extname(filename).toLowerCase();
}
