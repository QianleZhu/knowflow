// 真实 Docling 与真实视觉模型验证：图片位置、原位回填、图片标记清除和 PDF 页码。
import "../shared/config/load-env.js";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { db } from "@knowflow/db";
import { parseDocumentBuffer } from "../modules/domains/document/parsers/registry.js";
import {
  backfillDoclingImages,
  type DoclingResult,
} from "../modules/domains/document/parsers/docling.parser.js";
import {
  splitParentChunks,
  splitChildChunks,
} from "../modules/domains/document/document-chunker.js";

// 使用真实结构服务和配置中的 OCR 模型，不伪造图片描述。
async function main(): Promise<void> {
  const fixture = new URL("../modules/domains/document/parsers/fixtures/", import.meta.url);
  const image = await readFile(new URL("inline-diagram.png", fixture));
  const markdown = `# 图片上下文验证\n\nBEFORE_IMAGE: 下图介绍输入输出的关系。\n\n![流程图](data:image/png;base64,${image.toString("base64")})\n\nAFTER_IMAGE: 这里是图片之后的解释。`;
  const output = new URL("../../../../output/docling/", import.meta.url);
  await mkdir(output, { recursive: true });
  const selection = process.argv[2];
  const structureOnly = process.argv.includes("--structure-only");
  for (const format of ["md", "docx", "pdf"] as const) {
    if (selection !== undefined && selection !== format) continue;
    const buffer =
      format === "md"
        ? Buffer.from(markdown)
        : await readFile(new URL(`inline-image.${format}`, fixture));
    // 先验证服务导出的真实图片标记在前后文之间，且存在匹配的图片资源。
    const response = await fetch(
      `${process.env["DOCLING_URL"] ?? "http://127.0.0.1:5001"}/convert`,
      {
        method: "POST",
        signal: AbortSignal.timeout(300_000),
        headers: {
          "Content-Type": "application/json",
          ...(process.env["DOCLING_API_KEY"]
            ? { "X-Api-Key": process.env["DOCLING_API_KEY"] }
            : {}),
        },
        body: JSON.stringify({ format, base64: buffer.toString("base64") }),
      },
    );
    assert.equal(response.status, 200, `Docling ${format} HTTP ${String(response.status)}`);
    const structure = (await response.json()) as DoclingResult;
    assert.ok(
      Array.isArray(structure.blocks) && structure.blocks.length > 0,
      `${format} 没有返回可用于结构切分的 Docling 文档树`,
    );
    const raw = structure.pages.map((page) => page.markdown).join("\n\n");
    assert.equal(structure.images.length, 1, `${format} 没有提取出图片资源`);
    const firstImage = structure.images[0];
    assert.ok(firstImage);
    const marker = firstImage.marker;
    assert.ok(
      raw.indexOf("BEFORE") < raw.indexOf(marker),
      `${format} 图片标记没有位于图前正文之后`,
    );
    assert.ok(raw.indexOf(marker) < raw.indexOf("AFTER"), `${format} 图片标记没有位于图后正文之前`);
    // 走正式注册表，覆盖服务调用、图片 OCR、清洗以及分块入口。
    // 无 OCR 配置时可显式使用描述替身，只验证真实解析和回填，不声称真实识别。
    const parsed = structureOnly
      ? await backfillDoclingImages(structure, format, (_, stats) => {
          stats.attempted += 1;
          stats.inserted += 1;
          return Promise.resolve("测试描述：INPUT 42 → OUTPUT 84。");
        })
      : await parseDocumentBuffer(buffer, {
          sourceType: format === "md" ? "markdown" : format,
          mimeType: null,
          documentId: "docling-smoke",
          title: "图片上下文验证",
        });
    assert.equal(parsed.metadata.parser, format === "md" && !structureOnly ? "remark" : "docling");
    assert.equal(
      parsed.metadata.visionImageInsertedCount,
      1,
      `${format} 图片 OCR 未成功：${JSON.stringify(parsed.metadata.multimodalWarnings)}`,
    );
    assert.match(parsed.text, /42/);
    assert.match(parsed.text, /84/);
    assert.ok(parsed.text.indexOf("BEFORE") < parsed.text.indexOf("42"));
    assert.ok(parsed.text.indexOf("42") < parsed.text.indexOf("AFTER"));
    assert.doesNotMatch(parsed.text, /KNOWFLOW_IMAGE|<!-- image|!\[[^\]]*\]\(|data:image/);
    if (format === "pdf") {
      assert.equal(parsed.metadata.pdfPageCount, 2);
      assert.match(parsed.text, /<!-- KNOWFLOW_PAGE_BREAK:1 -->/);
      assert.match(parsed.text, /<!-- KNOWFLOW_PAGE_BREAK:2 -->/);
    } else {
      assert.doesNotMatch(parsed.text, /KNOWFLOW_PAGE_BREAK/);
    }
    assert.ok(parsed.structuredBlocks, `${format} 没有返回 Docling 结构块`);
    const children = splitParentChunks(parsed.structuredBlocks).flatMap((parent) =>
      splitChildChunks(parent.content),
    );
    assert.ok(
      children.some((child) => child.content.includes("42") && child.content.includes("84")),
    );
    assert.ok(children.every((child) => !child.content.includes("KNOWFLOW_IMAGE")));
    await writeFile(new URL(`${format}-before.md`, output), raw);
    await writeFile(new URL(`${format}-after.md`, output), parsed.text);
    console.log(
      JSON.stringify({
        format,
        realDocling: true,
        realVision: !structureOnly,
        originalPosition: true,
        imageMarkersRemoved: true,
        pdfPageMarkersPreserved: format === "pdf",
        childCount: children.length,
      }),
    );
  }
}

// 验证结束时关闭数据库池，不让脚本留下连接。
try {
  await main();
} finally {
  await db.$client.end();
}
