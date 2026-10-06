import assert from "node:assert/strict";

// 构造仅含 ASCII 文本的多页 PDF，用于验证 Docling 的跨页来源信息。
export function buildTextPdf(pageTexts: string[]): Buffer {
  return buildContentPdf(
    pageTexts.map((text) => `BT /F1 12 Tf 72 720 Td (${text.replace(/[\\()]/g, "\\$&")}) Tj ET`),
  );
}

// 将独立页面内容流写入真实 PDF，用于字号层级、版面表格和物理页码集成验证。
export function buildContentPdf(pageContents: string[]): Buffer {
  const pageObjectIds = pageContents.map((_, index) => 3 + index * 2);
  const fontObjectId = 3 + pageContents.length * 2;
  const objects: string[] = [];
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] =
    "<< /Type /Pages /Kids [" +
    pageObjectIds.map((id) => `${String(id)} 0 R`).join(" ") +
    `] /Count ${String(pageContents.length)} >>`;

  pageContents.forEach((contentStream, index) => {
    const pageObjectId = pageObjectIds[index];
    assert.ok(pageObjectId);
    const contentObjectId = pageObjectId + 1;
    objects[pageObjectId] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${String(fontObjectId)} 0 R >> >> /Contents ${String(contentObjectId)} 0 R >>`;
    objects[contentObjectId] =
      `<< /Length ${String(Buffer.byteLength(contentStream, "ascii"))} >>\nstream\n${contentStream}\nendstream`;
  });
  objects[fontObjectId] =
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";

  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  // xref 保存对象在 PDF 字节流中的偏移，供解析器准确读取页面树。
  for (let objectId = 1; objectId < objects.length; objectId += 1) {
    offsets[objectId] = Buffer.byteLength(pdf, "ascii");
    const object = objects[objectId];
    assert.ok(object);
    pdf += `${String(objectId)} 0 obj\n${object}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf, "ascii");
  pdf += `xref\n0 ${String(objects.length)}\n0000000000 65535 f \n`;
  for (let objectId = 1; objectId < objects.length; objectId += 1) {
    pdf += `${String(offsets[objectId]).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${String(objects.length)} /Root 1 0 R >>\nstartxref\n${String(xrefOffset)}\n%%EOF\n`;
  return Buffer.from(pdf, "ascii");
}
