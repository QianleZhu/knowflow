// 统一结构块父子切分：标题路径放入元数据，正文、来源和表格行均来自解析器结构节点。
import type {
  ContentSource,
  ParsedContentBlock,
  StructuredTable,
  TableRow,
} from "./document-blocks.js";
import {
  ensureBlockSources,
  parseMarkdownBlocks,
  renderTable,
} from "./parsers/structured-content.js";
import {
  recursiveSplitText,
  splitFencedCode,
  addCompleteSentenceOverlap,
} from "./document-text-splitter.js";

const PARENT_TARGET_CHARS = 2000;
const PARENT_MAX_CHARS = 2500;
const CHILD_TARGET_CHARS = 200;
const CHILD_MAX_CHARS = 250;
const CHILD_OVERLAP_CHARS = 60;
// 普通段落先预留重叠预算，避免把重叠文本加到 200 字符目标之外。
const CHILD_BASE_TARGET_CHARS = CHILD_TARGET_CHARS - CHILD_OVERLAP_CHARS;
export const CHUNKER_VERSION = "structured-chunker-v7";
type BoundaryType = "heading" | "table" | "list" | "paragraph" | "sentence" | "length";
export type ParentChunkInput = {
  title: string | null;
  content: string;
  metadata: {
    // 保存完整祖先标题路径，供检索和问答使用。
    headingPath: string[];
  };
  boundaryType: BoundaryType;
  pageStart: number | null;
  pageEnd: number | null;
  pageNumbers: number[];
  sources: ContentSource[];
  tableIds: string[];
  blocks: ParsedContentBlock[];
};
type ChildChunkInput = {
  content: string;
  chunkIndex: number;
  boundaryType: BoundaryType;
};
type Heading = { title: string; level: number };

// 按标题层级组织章节；显式拒绝缺少结构块的解析结果，杜绝旧 Markdown 分支回流。
export function splitParentChunks(
  structuredBlocks: ParsedContentBlock[] | undefined,
): ParentChunkInput[] {
  if (structuredBlocks === undefined || structuredBlocks.length === 0)
    throw new Error("结构化切分缺少文档树节点");
  const parents: ParentChunkInput[] = [];
  let headings: Heading[] = [];
  let body: ParsedContentBlock[] = [];
  let ownHeading: ParsedContentBlock | null = null;
  // 保存同一标题范围内的结构节点，分页不是章节边界。
  function flushSection(): void {
    if (body.length === 0 && ownHeading === null) return;
    // 标题路径只写入父块元数据，正文切分预算完整留给实际内容。
    const target = PARENT_TARGET_CHARS;
    const atoms = mergePageContinuations(body, target).flatMap((block) =>
      splitBlock(block, target),
    );
    let current: ParsedContentBlock[] = [];
    let first = true;
    // 重复祖先标题不参与页码计算；当前标题只作为章节首块的实际来源。
    function flushParent(): void {
      if (current.length === 0) return;
      const blocks = [...current];
      const actual = [...(first && ownHeading !== null ? [ownHeading] : []), ...blocks];
      const sources = deduplicateSources(actual.flatMap((block) => block.sources ?? []));
      const pageNumbers = uniquePages(actual.flatMap((block) => block.pageNumbers));
      const content = blocks.map((block) => block.markdown).join("\n\n");
      if (content.length === 0) return;
      if (content.length > PARENT_MAX_CHARS)
        throw new Error("结构节点的格式上下文超过父块上限，无法无损切分");
      parents.push({
        title: headings.at(-1)?.title ?? null,
        content,
        // 保存完整标题路径供检索使用，不拼入正文或正文长度计算。
        metadata: { headingPath: headings.map((heading) => heading.title) },
        boundaryType: blocks.some((block) => block.kind === "table")
          ? "table"
          : first && ownHeading !== null
            ? "heading"
            : boundaryType(blocks[0]),
        pageStart: pageNumbers[0] ?? null,
        pageEnd: pageNumbers.at(-1) ?? null,
        pageNumbers,
        sources,
        tableIds: [
          ...new Set(
            blocks.flatMap((block) =>
              block.table !== undefined
                ? [block.table.header.id]
                : block.tableRecord !== undefined
                  ? [block.tableRecord.tableId]
                  : [],
            ),
          ),
        ],
        blocks,
      });
      first = false;
      current = [];
    }
    for (const atom of atoms) {
      // 表格独占父块，子块可直接用行结构重复表头，避免混入正文导致行丢失。
      if (atom.kind === "table") {
        if (current.length > 0) flushParent();
        current = [atom];
        flushParent();
        continue;
      }
      const size = current.reduce((total, block) => total + block.markdown.length + 2, 0);
      if (current.length > 0 && size + atom.markdown.length > target) flushParent();
      current.push(atom);
    }
    flushParent();
    body = [];
    ownHeading = null;
  }
  for (const [index, original] of structuredBlocks.entries()) {
    const block = ensureBlockSources(original, index);
    if (block.markdown.trim().length === 0) continue;
    if (block.kind !== "heading") {
      body.push(block);
      continue;
    }
    flushSection();
    const level = block.level ?? 1;
    const title = block.markdown.replace(/^#{1,6}\s+/, "").trim();
    // 用真实 level 栈处理跳级标题，不依赖数组下标等于层级。
    headings = headings.filter((heading) => heading.level < level);
    headings.push({ title, level });
    ownHeading = block;
  }
  flushSection();
  return parents;
}

// 只合并紧邻、相邻页、表头一致的表格；不凭相同列数猜测表格延续。
function mergePageContinuations(
  blocks: ParsedContentBlock[],
  target: number,
): ParsedContentBlock[] {
  const output: ParsedContentBlock[] = [];
  for (const block of blocks) {
    //检查和上一块可不可以合并
    const previous = output.at(-1);
    const lastPage = previous?.pageNumbers.at(-1);
    const nextPage = block.pageNumbers[0];
    if (
      previous?.table !== undefined &&
      block.table !== undefined &&
      lastPage !== undefined &&
      nextPage === lastPage + 1 &&
      previous.table.header.sources.length > 0 &&
      block.table.header.sources.length > 0 &&
      previous.table.header.cells.length === block.table.header.cells.length &&
      previous.table.header.cells.every(
        (cell, index) => cell.text.trim() === block.table?.header.cells[index]?.text.trim(),
      )
    ) {
      const table = {
        header: previous.table.header,
        rows: [...previous.table.rows, ...block.table.rows],
      };
      // 合并只消除第二张表的表头，不删除与表头或其他行同文的数据行。
      output[output.length - 1] = {
        ...previous,
        markdown: renderTable(table),
        table,
        pageNumbers: uniquePages([...previous.pageNumbers, ...block.pageNumbers]),
        sources: deduplicateSources([...(previous.sources ?? []), ...(block.sources ?? [])]),
      };
    } else if (
      previous?.kind === "paragraph" &&
      block.kind === "paragraph" &&
      lastPage !== undefined &&
      nextPage === lastPage + 1 &&
      previous.markdown.length + block.markdown.length + 1 <= target &&
      !/[。！？.!?；;：:]\s*[”’"')\]]*\s*$/.test(previous.markdown) &&
      /^[a-z\u4e00-\u9fff]/.test(block.markdown.trimStart())
    ) {
      // 仅拼接跨页未结束的短句；不确定的段落保持独立节点，仍可装进同一个父块。
      const separator =
        /[A-Za-z0-9]$/.test(previous.markdown) && /^[a-z]/.test(block.markdown) ? " " : "";
      output[output.length - 1] = {
        ...previous,
        markdown: `${previous.markdown}${separator}${block.markdown}`,
        pageNumbers: uniquePages([...previous.pageNumbers, ...block.pageNumbers]),
        sources: deduplicateSources([...(previous.sources ?? []), ...(block.sources ?? [])]),
      };
    } else output.push(block);
  }
  return output;
}

// 超长节点保留原节点来源；表格优先按整行拆，代码优先按代码行拆。
function splitBlock(block: ParsedContentBlock, target: number): ParsedContentBlock[] {
  if (block.table !== undefined) return splitTable(block, target);
  if (block.tableRecord !== undefined) return splitTableRecord(block, target);
  if (block.markdown.length <= target) return [block];
  const pieces =
    block.kind === "code"
      ? splitFencedCode(block.markdown, target)
      : recursiveSplitText(block.markdown, target, 0, block.textFormat === "plain");
  return pieces.map((markdown) => ({ ...block, markdown }));
}

// 按行生成表格片段；重复表头是上下文，不扩展数据行的来源页码。
function splitTable(block: ParsedContentBlock, target: number): ParsedContentBlock[] {
  if (block.table === undefined) throw new Error("表格切分缺少结构化行");
  const table = block.table;
  const output: ParsedContentBlock[] = [];
  let rows: TableRow[] = [];
  // 汇总片段的数据行来源，无数据行时才使用表头自身来源。
  function emit(): void {
    if (rows.length === 0) return;
    const part: StructuredTable = { header: table.header, rows };
    const sources = deduplicateSources(rows.flatMap((row) => row.sources));
    output.push({
      ...block,
      table: part,
      markdown: renderTable(part),
      sources,
      pageNumbers: uniquePages(sources.flatMap((source) => source.pageNumbers)),
    });
    rows = [];
  }
  if (table.rows.length === 0) {
    if (block.markdown.length <= target) return [block];
    // 只有表头的超宽表仍需保留列名，使用表头来源生成字段记录。
    const row = {
      ...table.header,
      cells: table.header.cells.map((cell) => ({ ...cell, text: "（无数据行）" })),
    };
    return splitOversizedRow(block, row, target);
  }
  for (const row of table.rows) {
    if (renderTable({ header: table.header, rows: [row] }).length > target) {
      emit();
      output.push(...splitOversizedRow(block, row, target));
      continue;
    }
    if (
      rows.length > 0 &&
      renderTable({ header: table.header, rows: [...rows, row] }).length > target
    )
      emit();
    rows.push(row);
  }
  emit();
  return output;
}

// 超宽或单元格超长的行改为带行 ID、列名的记录，避免把半行拼成损坏 Markdown 表格。
function splitOversizedRow(
  block: ParsedContentBlock,
  row: TableRow,
  target: number,
): ParsedContentBlock[] {
  return row.cells.flatMap((cell, index) => {
    const columnName = block.table?.header.cells[index]?.text ?? "";
    const label = columnName.length === 0 ? `列 ${String(index + 1)}` : columnName;
    const sources = cell.sources.length > 0 ? cell.sources : row.sources;
    const tableRecord = {
      tableId: block.table?.header.id ?? row.id,
      rowId: row.id,
      columnIndex: index + 1,
      columnName: label,
      field: "value" as const,
      value: cell.text.length === 0 ? "（空）" : cell.text,
    };
    const record: ParsedContentBlock = {
      kind: "paragraph",
      markdown: "",
      level: null,
      sources,
      pageNumbers: uniquePages(sources.flatMap((source) => source.pageNumbers)),
      tableRecord,
    };
    // 超长列名本身也输出为可检索内容，不能通过截取展示前缀丢失原始表头。
    const header =
      label.length > 200
        ? splitTableRecord(
            { ...record, tableRecord: { ...tableRecord, field: "name", value: label } },
            target,
          )
        : [];
    return [...header, ...splitTableRecord(record, target)];
  });
}

// 将超长记录继续拆成带相同行列上下文的片段，父块和子块都复用此规则。
function splitTableRecord(block: ParsedContentBlock, target: number): ParsedContentBlock[] {
  const record = block.tableRecord;
  if (record === undefined) throw new Error("表格记录切分缺少行列信息");
  const identity = `表格行 ${record.rowId.slice(0, 120)}\n列 ${String(record.columnIndex)}${record.columnName.length <= 200 ? `：${record.columnName}` : ""}\n${record.field === "name" ? "列名" : "列值"}：`;
  return recursiveSplitText(record.value, Math.max(1, target - identity.length - 2)).map(
    (value) => ({
      ...block,
      markdown: `${identity}\n\n${value}`,
      tableRecord: { ...record, value },
    }),
  );
}

// 子块使用父块内保留的结构节点，页码与标题路径由 processor 直接继承父块元数据。
export function splitChildChunks(content: string, parent?: ParentChunkInput): ChildChunkInput[] {
  if (content.length <= CHILD_TARGET_CHARS)
    return content.trim().length === 0
      ? []
      : [
          {
            content,
            chunkIndex: 0,
            boundaryType: parent?.boundaryType ?? "paragraph",
          },
        ];
  const blocks = parent?.blocks.length ? parent.blocks : parseMarkdownBlocks(content);
  const chunks: { content: string; boundaryType: BoundaryType }[] = [];
  let current = "";
  // 保存当前文本子块，表格和代码切换时结束合并。
  function flush(): void {
    if (current.length > 0) chunks.push({ content: current, boundaryType: "paragraph" });
    current = "";
  }
  for (const [index, original] of blocks.entries()) {
    const block = ensureBlockSources(original, index);
    if (block.kind === "table" || block.kind === "code" || block.tableRecord !== undefined) {
      flush();
      for (const piece of splitBlock(block, CHILD_TARGET_CHARS))
        chunks.push({ content: piece.markdown, boundaryType: boundaryType(piece) });
      continue;
    }
    // 普通段落按预留重叠后的正文长度切分；列表等块仍按子块目标切分。
    const targetChars = block.kind === "paragraph" ? CHILD_BASE_TARGET_CHARS : CHILD_TARGET_CHARS;
    const pieces = recursiveSplitText(block.markdown, targetChars, 0, block.textFormat === "plain");
    const withOverlap =
      block.kind === "paragraph"
        ? addCompleteSentenceOverlap(pieces, CHILD_OVERLAP_CHARS, CHILD_MAX_CHARS)
        : pieces;
    for (const piece of withOverlap) {
      if (current.length > 0 && current.length + piece.length + 2 > CHILD_TARGET_CHARS) flush();
      current = current.length === 0 ? piece : `${current}\n\n${piece}`;
    }
  }
  flush();
  if (chunks.some((chunk) => chunk.content.length > CHILD_MAX_CHARS))
    throw new Error("结构节点的格式上下文超过子块上限，无法无损切分");
  return chunks.map((chunk, chunkIndex) => ({
    ...chunk,
    chunkIndex,
  }));
}

// 来源按稳定节点 ID 与坐标去重，避免跨页拼接后重复登记。
function deduplicateSources(sources: ContentSource[]): ContentSource[] {
  return [...new Map(sources.map((source) => [JSON.stringify(source), source])).values()];
}

// 页码保存确切集合，起止页只是展示范围。
function uniquePages(pages: number[]): number[] {
  return [...new Set(pages)]
    .filter((page) => Number.isSafeInteger(page) && page > 0)
    .sort((a, b) => a - b);
}

// 结构块类型直接决定片段边界，不再对首行使用正则分类。
function boundaryType(block: ParsedContentBlock | undefined): BoundaryType {
  return block?.kind === "heading" || block?.kind === "table" || block?.kind === "list"
    ? block.kind
    : "paragraph";
}
