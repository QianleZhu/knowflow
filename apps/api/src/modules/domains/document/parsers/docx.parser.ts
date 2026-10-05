// DOCX 通过 Docling 保留文字与图片顺序，复用统一原位回填流程。
import { parseDoclingDocument } from "./docling.parser.js";

// 解析 Word 文档并在原图片位置写入视觉描述。
export function parseDocxDocument(buffer: Buffer) {
  return parseDoclingDocument(buffer, "docx");
}
