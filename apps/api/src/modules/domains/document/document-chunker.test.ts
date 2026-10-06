import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isMarkdownTableSeparatorLine } from "./document-text-structure.js";
import { splitParentChunks, splitChildChunks } from "./document-chunker.js";
import { parseMarkdownBlocks, parsePlainTextBlocks } from "./parsers/structured-content.js";
import type { ParsedContentBlock } from "./document-blocks.js";

const TABLE_HEADER = "| 项目 | 金额 | 负责人 |";
const TABLE_SEPARATOR = "| --- | --- | --- |";

// 构造一张 N 行的费用报销表，用于触发长表格切分。
function buildExpenseTable(rows: number, withSeparator = true): string {
  const lines = [TABLE_HEADER];
  if (withSeparator) {
    lines.push(TABLE_SEPARATOR);
  }
  for (let i = 1; i <= rows; i += 1) {
    lines.push(
      `| 差旅报销第${String(i)}项 | ${String(10000 + i)} | 市场部第${String(i)}小组张三 |`,
    );
  }
  return lines.join("\n");
}

// 提取内容中的数据行（排除表头与分隔行）。
function dataRowsOf(content: string): string[] {
  return content
    .split("\n")
    .filter((line) => line.startsWith("|") && line !== TABLE_HEADER && line !== TABLE_SEPARATOR);
}

// 构造无换行的普通中文段落。
function buildParagraph(sentences: number): string {
  return Array.from(
    { length: sentences },
    (_, i) =>
      `这是第${String(i)}段测试内容，用于验证普通文本子块切分仍然带有重叠上下文，句子以句号结尾。`,
  ).join("");
}

void describe("markdown table separator detection", () => {
  void it("recognizes separator rows and rejects data rows", () => {
    assert.equal(isMarkdownTableSeparatorLine("| --- | --- |"), true);
    assert.equal(isMarkdownTableSeparatorLine("| :--- | ---: |"), true);
    assert.equal(isMarkdownTableSeparatorLine("|---|---|"), true);
    assert.equal(isMarkdownTableSeparatorLine("| a | b |"), false);
    assert.equal(isMarkdownTableSeparatorLine("| - | - |"), false);
    assert.equal(isMarkdownTableSeparatorLine("| --- "), false);
  });
});

void describe("long table parent splitting", () => {
  void it("splits long tables by whole rows and prepends the header to every parent", () => {
    const table = buildExpenseTable(140);
    const parents = splitParentChunks(parseMarkdownBlocks(table));

    assert.ok(parents.length >= 2, "long table should be split into multiple parents");
    for (const parent of parents) {
      const lines = parent.content.split("\n");
      assert.equal(lines[0], TABLE_HEADER, "every piece must start with the header row");
      assert.equal(lines[1], TABLE_SEPARATOR, "every piece must keep the separator row");
      assert.equal(parent.boundaryType, "table");
      for (const line of lines) {
        assert.ok(
          line.startsWith("|") && line.endsWith("|"),
          `table row must not be cut mid-line: ${line}`,
        );
      }
      assert.ok(parent.content.length <= 4000, "piece must stay within parent max chars");
    }

    const allRows = parents.flatMap((parent) => dataRowsOf(parent.content));
    assert.equal(allRows.length, 140, "no data row may be lost or duplicated");
    assert.equal(new Set(allRows).size, 140);
    for (const parent of parents.slice(0, -1)) {
      assert.ok(parent.content.length >= 2000, "filled pieces should approach the target size");
    }
  });

  void it("keeps short tables as a single parent without duplication", () => {
    const table = buildExpenseTable(6);
    const parents = splitParentChunks(parseMarkdownBlocks(table));

    assert.equal(parents.length, 1);
    const first = parents[0];
    assert.ok(first);
    assert.equal(first.content, table);
    assert.equal(dataRowsOf(first.content).length, 6);
  });

  void it("does not guess a table when a Markdown separator is absent", () => {
    const text = buildExpenseTable(6, false);
    const blocks = parseMarkdownBlocks(text);
    assert.equal(blocks[0]?.kind, "paragraph");
    assert.equal(splitParentChunks(blocks)[0]?.boundaryType, "paragraph");
  });

  void it("keeps source page numbers on all pieces of a long table", () => {
    const parents = splitParentChunks(parseMarkdownBlocks(buildExpenseTable(140), [3]));

    assert.ok(parents.length >= 2);
    for (const parent of parents) {
      assert.equal(parent.pageStart, 3);
      assert.equal(parent.pageEnd, 3);
    }
  });
});

// 验证 Docling 长结构节点按句子拆父块，并保留节点的跨页范围。
void describe("structured parent splitting", () => {
  void it("preserves indentation while splitting long TXT code-like paragraphs", () => {
    const text = Array.from(
      { length: 120 },
      (_, index) => `    step${String(index)} = value${String(index)}`,
    ).join("\n");
    const parents = splitParentChunks(parsePlainTextBlocks(text));
    const children = parents.flatMap((parent) => splitChildChunks(parent.content, parent));
    assert.ok(children.length > 1);
    assert.ok(
      children.every((child) =>
        child.content
          .split("\n")
          .filter((line) => line.length > 0)
          .every((line) => line.startsWith("    step")),
      ),
    );
    assert.equal(
      children.flatMap((child) => [...child.content.matchAll(/step\d+ = value\d+/g)]).length,
      120,
    );
  });
  void it("keeps adjacent headings in separate parents without duplicating them or losing hierarchy", () => {
    const blocks: ParsedContentBlock[] = [
      { kind: "heading", markdown: "# TCP 握手总结", level: 1, pageNumbers: [1] },
      { kind: "heading", markdown: "# TCP 握手总结", level: 1, pageNumbers: [1] },
      { kind: "heading", markdown: "## TCP 基本认识", level: 2, pageNumbers: [1] },
      { kind: "heading", markdown: "## TCP 基本认识", level: 2, pageNumbers: [1] },
    ];
    const parents = splitParentChunks(blocks);

    assert.deepEqual(
      parents.map((parent) => parent.content),
      [
        "# TCP 握手总结",
        "# TCP 握手总结",
        "# TCP 握手总结\n\n## TCP 基本认识",
        "# TCP 握手总结\n\n## TCP 基本认识",
      ],
    );
    assert.deepEqual(parents[2]?.headingPath, ["TCP 握手总结", "TCP 基本认识"]);
    assert.deepEqual(parents[3]?.headingPath, ["TCP 握手总结", "TCP 基本认识"]);
  });

  void it("rejects an explicitly empty tree instead of falling back to Markdown", () => {
    assert.throws(() => splitParentChunks([]), /缺少文档树节点/);
    assert.throws(() => splitParentChunks(undefined), /缺少文档树节点/);
  });

  void it("splits an oversized paragraph at sentence boundaries and retains its page range", () => {
    const source: ParsedContentBlock = {
      kind: "paragraph",
      markdown: buildParagraph(100),
      level: null,
      pageNumbers: [1, 2],
    };
    const parents = splitParentChunks([source]);

    assert.ok(parents.length > 1);
    assert.ok(
      parents.every((parent) => parent.content.length > 0 && parent.content.length <= 4000),
    );
    assert.ok(parents.every((parent) => parent.pageStart === 1 && parent.pageEnd === 2));
    assert.ok(
      parents.every(
        (parent) => parent.content.startsWith("这是第") && parent.content.endsWith("。"),
      ),
    );
    const sentenceIndexes = parents.flatMap((parent) =>
      [...parent.content.matchAll(/这是第(\d+)段/g)].map((match) => match[1]),
    );
    assert.deepEqual(
      sentenceIndexes,
      Array.from({ length: 100 }, (_, index) => String(index)),
      "all sentences must remain in source order without loss or duplication",
    );
  });
});

void describe("table child splitting", () => {
  void it("splits pure table child chunks by rows with header and without overlap", () => {
    const table = buildExpenseTable(40);
    const children = splitChildChunks(table);

    assert.ok(children.length >= 2, "long table should produce multiple child chunks");
    const seen = new Set<string>();
    children.forEach((child, index) => {
      assert.equal(child.chunkIndex, index);
      const lines = child.content.split("\n");
      assert.equal(lines[0], TABLE_HEADER, "every child must start with the header row");
      assert.equal(lines[1], TABLE_SEPARATOR);
      for (const line of lines) {
        assert.ok(line.startsWith("|") && line.endsWith("|"));
      }
      assert.ok(child.content.length <= 1100, "child should stay near the target size");
      for (const row of dataRowsOf(child.content)) {
        assert.ok(!seen.has(row), "table child chunks must not overlap data rows");
        seen.add(row);
      }
    });
    assert.equal(seen.size, 40, "no data row may be lost or duplicated");
  });

  void it("keeps table rows intact when child content mixes table and paragraph", () => {
    const mixed = [buildExpenseTable(10), buildParagraph(60)].join("\n\n");
    const children = splitChildChunks(mixed);

    assert.ok(children.length >= 2);
    for (const child of children) {
      for (const line of child.content.split("\n")) {
        if (line.startsWith("|")) {
          assert.ok(line.endsWith("|"), `row cut mid-line: ${line}`);
        }
      }
    }
  });

  void it("splits plain paragraph children at complete sentence boundaries", () => {
    const paragraph = buildParagraph(60);
    const children = splitChildChunks(paragraph);

    assert.ok(children.length >= 2);
    for (const child of children) {
      assert.match(child.content, /^这是第\d+段/);
      assert.ok(child.content.endsWith("。"), "every child must end after a complete sentence");
    }
  });
});

// 跨页长表格按行绑定来源，重复表头不会把所有父块都拉回第一页。
void describe("structured table provenance and oversized cells", () => {
  void it("merges compatible table continuations and retains exact row pages through parent and child splitting", () => {
    const blocks = [1, 2, 3].flatMap((page) =>
      parseMarkdownBlocks(
        `| 编号 | 内容 |\n| --- | --- |\n${Array.from({ length: 60 }, (_, index) => `| ${String((page - 1) * 60 + index + 1)} | ${"记录".repeat(25)} |`).join("\n")}`,
        [page],
        `page${String(page)}`,
      ),
    );
    const parents = splitParentChunks(blocks);
    assert.ok(parents.length > 3);
    assert.ok(parents.every((parent) => parent.tableIds[0] === parents[0]?.tableIds[0]));
    assert.deepEqual(parents.at(-1)?.pageNumbers, [3]);
    assert.ok(parents.every((parent) => parent.content.length <= 4000));
    const rows = parents.flatMap((parent) =>
      parent.blocks.flatMap((block) => block.table?.rows ?? []),
    );
    assert.equal(rows.length, 180);
    assert.equal(new Set(rows.map((row) => row.id)).size, 180);
    for (const parent of parents) {
      const expectedPages = [
        ...new Set(
          parent.blocks.flatMap(
            (block) =>
              block.table?.rows.flatMap((row) =>
                row.sources.flatMap((source) => source.pageNumbers),
              ) ?? [],
          ),
        ),
      ];
      assert.deepEqual(parent.pageNumbers, expectedPages);
      const children = splitChildChunks(parent.content, parent);
      const indexes = children.flatMap((child) =>
        [...child.content.matchAll(/^\| (\d+) \|/gm)].map((match) => Number(match[1])),
      );
      assert.equal(
        indexes.length,
        parent.blocks.flatMap((block) => block.table?.rows ?? []).length,
      );
      assert.equal(new Set(indexes).size, indexes.length);
      assert.ok(children.every((child) => child.content.length <= 900));
    }
  });

  void it("does not merge tables based only on equal column counts", () => {
    const blocks = [
      ...parseMarkdownBlocks("| 姓名 | 金额 |\n| --- | --- |\n| 甲 | 1 |", [1], "first"),
      ...parseMarkdownBlocks("| 项目 | 数量 |\n| --- | --- |\n| 产品 | 2 |", [2], "second"),
    ];
    const parents = splitParentChunks(blocks);
    assert.equal(parents.length, 2);
    assert.deepEqual(
      parents.map((parent) => parent.pageNumbers),
      [[1], [2]],
    );
  });

  void it("retains a data row identical to a repeated header", () => {
    const blocks = [1, 2].flatMap((page) =>
      parseMarkdownBlocks(
        "| 姓名 | 金额 |\n| --- | --- |\n| 姓名 | 金额 |",
        [page],
        `page${String(page)}`,
      ),
    );
    const parents = splitParentChunks(blocks);
    assert.equal(parents.length, 1);
    assert.equal(parents[0]?.blocks[0]?.table?.rows.length, 2);
    assert.deepEqual(parents[0].pageNumbers, [1, 2]);
  });

  void it("splits huge cells and headers as labeled records without dropping values or exceeding limits", () => {
    const name = "超长列名".repeat(500);
    const value = Array.from(
      { length: 140 },
      (_, index) => `单元格记录${String(index)}结束。`,
    ).join("");
    const blocks = parseMarkdownBlocks(
      `| ${name} | 普通列 |\n| --- | --- |\n| ${value} | 关联键ABC |`,
      [7],
    );
    const parents = splitParentChunks(blocks);
    assert.ok(parents.every((parent) => parent.content.length <= 4000 && parent.pageStart === 7));
    const children = parents.flatMap((parent) => splitChildChunks(parent.content, parent));
    assert.ok(
      children.every((child) => child.content.length <= 900 && child.content.includes("表格行")),
    );
    const indexes = children.flatMap((child) =>
      [...child.content.matchAll(/单元格记录(\d+)结束。/g)].map((match) => Number(match[1])),
    );
    assert.deepEqual(
      indexes,
      Array.from({ length: 140 }, (_, index) => index),
    );
    const headerParts = parents
      .flatMap((parent) => parent.blocks)
      .filter((block) => block.tableRecord?.field === "name")
      .map((block) => block.tableRecord?.value)
      .join("");
    assert.equal(headerParts, name);
    assert.ok(children.some((child) => child.content.includes("关联键ABC")));
  });
});
