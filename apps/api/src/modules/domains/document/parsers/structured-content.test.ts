// 验证统一来源协议与不同格式的原生结构，不依赖 Docling 服务或真实模型调用。
import assert from "node:assert/strict";
import { it } from "node:test";
import * as XLS from "@e965/xlsx";
import { parseMarkdownBlocks, parsePlainTextBlocks, decodeText } from "./structured-content.js";
import { parseDocumentBuffer } from "./registry.js";
import { splitParentChunks, splitChildChunks } from "../document-chunker.js";
import { validateDocumentUploadContent } from "../../../../shared/upload/upload-file-validation.js";
import { readFile } from "node:fs/promises";
import { parseMarkdownDocument } from "./markdown.parser.js";

void it("recognizes code fences, setext headings, lists, escaped pipes and multiline paragraphs with AST", () => {
  const blocks = parseMarkdownBlocks(
    "总标题\n======\n\n```python\n# 注释不是标题\n1. 代码\n```\n\n- 项目一\n  - 项目二\n\n| 名称 | 内容 |\n| --- | --- |\n| a\\|b | `x` |",
    [4],
  );
  assert.deepEqual(
    blocks.map((block) => block.kind),
    ["heading", "code", "list", "table"],
  );
  assert.equal(blocks[0]?.level, 1);
  assert.deepEqual(splitParentChunks(blocks)[0]?.headingPath, ["总标题"]);
  assert.equal(blocks[3]?.table?.rows[0]?.cells[0]?.text, "a\\|b");
  assert.ok(
    blocks.every(
      (block) => block.sources?.[0]?.lineStart !== undefined && block.pageNumbers[0] === 4,
    ),
  );
});

void it("decodes UTF-16 and GB18030 without guessing TXT headings", async () => {
  const buffer = Buffer.concat([
    Buffer.from([0xff, 0xfe]),
    Buffer.from("# 注释\n\n    return 1\n\n一、正文", "utf16le"),
  ]);
  assert.ok(
    validateDocumentUploadContent(
      { originalname: "notes.txt", mimetype: "text/plain", buffer },
      { sourceType: "txt", extension: ".txt" },
    ),
  );
  const parsed = await parseDocumentBuffer(buffer, {
    sourceType: "txt",
    mimeType: "text/plain",
    documentId: "text",
    title: "文本",
  });
  assert.ok(parsed.structuredBlocks?.every((block) => block.kind === "paragraph"));
  assert.match(parsed.text, / {4}return 1/);
  assert.equal(decodeText(Buffer.from([0xd6, 0xd0, 0xce, 0xc4])), "中文");
  assert.equal(parsePlainTextBlocks("\n\n正文")[0]?.sources?.[0]?.lineStart, 3);
});

void it("parses Markdown natively without an available Docling service", async () => {
  const parsed = await parseDocumentBuffer(
    Buffer.from("# 标题\n\n```js\n# comment\n```\n\n## 小节\n\n正文"),
    { sourceType: "markdown", mimeType: "text/markdown", documentId: "md", title: "Markdown" },
  );
  assert.equal(parsed.metadata.parser, "remark");
  assert.deepEqual(
    parsed.structuredBlocks?.map((block) => block.kind),
    ["heading", "code", "heading", "paragraph"],
  );
  assert.deepEqual(splitParentChunks(parsed.structuredBlocks).at(-1)?.headingPath, [
    "标题",
    "小节",
  ]);
});

void it("preserves original sheet row coordinates and separates regions for xlsx and xls", async () => {
  for (const bookType of ["xlsx", "xls"] as const) {
    const book = XLS.utils.book_new();
    XLS.utils.book_append_sheet(
      book,
      XLS.utils.aoa_to_sheet([[], ["姓名", "金额"], ["甲", 10], [], ["乙", 20], ["丙", 30]]),
      "预算",
    );
    const buffer = XLS.write(book, { type: "buffer", bookType }) as Buffer;
    const parsed = await parseDocumentBuffer(buffer, {
      sourceType: "excel",
      mimeType: null,
      documentId: "sheet",
      title: "表格",
    });
    const tables = parsed.structuredBlocks?.filter((block) => block.kind === "table") ?? [];
    assert.equal(tables.length, 2);
    assert.deepEqual(
      tables.flatMap((block) => block.sources?.map((source) => source.rowStart)),
      [2, 3, 5, 6],
    );
    assert.equal(tables[1]?.table?.rows.length, 2, "没有明确表头时第一条记录仍为数据");
    const parents = splitParentChunks(parsed.structuredBlocks);
    assert.ok(
      parents.every((parent) => parent.pageStart === null && parent.pageNumbers.length === 0),
    );
    for (const parent of parents) assert.ok(splitChildChunks(parent.content, parent).length > 0);
  }
});

void it("backfills Markdown images in place, caches identical bytes, preserves source lines and code examples", async () => {
  const image = await readFile(new URL("./fixtures/inline-diagram.png", import.meta.url));
  const uri = `data:image/png;base64,${image.toString("base64")}`;
  let calls = 0;
  const parsed = await parseMarkdownDocument(
    `# 标题\n\nBEFORE\n\n![图](${uri})\n\nAFTER\n\n| 图像 | 内容 |\n| --- | --- |\n| ![同图](${uri}) | 值 |\n\n\`\`\`md\n![示例](https://private.example/no-fetch.png)\n\`\`\`\n`,
    () => {
      calls += 1;
      return Promise.resolve("图片识别第一行\n图片识别第二行 | 内容");
    },
  );
  assert.equal(calls, 1);
  assert.ok(parsed.text.indexOf("BEFORE") < parsed.text.indexOf("图片识别第一行"));
  assert.ok(parsed.text.indexOf("图片识别第二行") < parsed.text.indexOf("AFTER"));
  assert.ok(!parsed.text.includes("data:image"));
  assert.match(parsed.text, /https:\/\/private.example\/no-fetch.png/);
  const picture = parsed.structuredBlocks?.find((block) => block.sources?.[0]?.lineStart === 5);
  assert.ok(picture);
  assert.ok(picture.markdown.includes("图片识别第二行"));
  assert.equal(picture.sources?.[0]?.lineEnd, 5);
  const table = parsed.structuredBlocks?.find((block) => block.kind === "table");
  assert.equal(table?.table?.rows.length, 1);
  assert.match(table.table.rows[0]?.cells[0]?.text ?? "", /<br>/);
});
