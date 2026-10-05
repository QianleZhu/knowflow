import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isMarkdownTableSeparatorLine, formatPageMarker } from "./document-text-structure.js";
import { splitParentChunks, splitChildChunks } from "./document-chunker.js";

const TABLE_HEADER = "| 项目 | 金额 | 负责人 |";
const TABLE_SEPARATOR = "| --- | --- | --- |";

// 构造一张 N 行的费用报销表，用于触发长表格切分。
function buildExpenseTable(rows: number, withSeparator = true): string {
  const lines = [TABLE_HEADER];
  if (withSeparator) {
    lines.push(TABLE_SEPARATOR);
  }
  for (let i = 1; i <= rows; i += 1) {
    lines.push(`| 差旅报销第${String(i)}项 | ${String(10000 + i)} | 市场部第${String(i)}小组张三 |`);
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
    const parents = splitParentChunks(table);

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
    const parents = splitParentChunks(table);

    assert.equal(parents.length, 1);
    const first = parents[0];
    assert.ok(first);
    assert.equal(first.content, table);
    assert.equal(dataRowsOf(first.content).length, 6);
  });

  void it("prepends only the header line for tables without a separator row", () => {
    const table = buildExpenseTable(140, false);
    const parents = splitParentChunks(table);

    assert.ok(parents.length >= 2);
    for (const parent of parents) {
      const lines = parent.content.split("\n");
      assert.equal(lines[0], TABLE_HEADER);
      assert.ok(lines[1]?.startsWith("| 差旅报销第"), "second line must be a data row");
      assert.equal(lines.includes(TABLE_SEPARATOR), false);
    }
    const allRows = parents.flatMap((parent) => dataRowsOf(parent.content));
    assert.equal(allRows.length, 140);
  });

  void it("keeps page numbers on table pieces split from a marked page", () => {
    const text = `${formatPageMarker(3)}\n${buildExpenseTable(140)}`;
    const parents = splitParentChunks(text);

    assert.ok(parents.length >= 2);
    for (const parent of parents) {
      assert.equal(parent.pageStart, 3);
      assert.equal(parent.pageEnd, 3);
    }
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

  void it("keeps overlap behavior for plain paragraph child chunks", () => {
    const paragraph = buildParagraph(60);
    const children = splitChildChunks(paragraph);

    assert.ok(children.length >= 2);
    const first = children[0];
    const second = children[1];
    assert.ok(first);
    assert.ok(second);
    assert.ok(
      second.content.startsWith(first.content.slice(-120)),
      "plain text children must keep the 120-char overlap context",
    );
  });
});
