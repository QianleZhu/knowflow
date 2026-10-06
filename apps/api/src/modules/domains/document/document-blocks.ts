// 所有解析器共享结构块协议；物理页码与原始行位置在解析阶段绑定，不从最终正文反查。
export type ContentSource = {
  blockId: string;
  pageNumbers: number[];
  // 表格没有可靠单元格页码时明确声明块级精度，不能伪造逐行定位。
  precision: "block" | "row" | "cell";
  lineStart?: number;
  lineEnd?: number;
  sheet?: string;
  rowStart?: number;
  rowEnd?: number;
};

export type TableCell = { text: string; sources: ContentSource[] };
export type TableRow = { id: string; cells: TableCell[]; sources: ContentSource[] };
export type StructuredTable = { header: TableRow; rows: TableRow[] };

// 节点类型来自各格式的原生解析结果，切块器不再猜测文本行属于什么类型。
export type ParsedContentBlock = {
  kind: "heading" | "paragraph" | "list" | "table" | "code" | "picture" | "other";
  markdown: string;
  level: number | null;
  pageNumbers: number[];
  sources?: ContentSource[];
  textFormat?: "plain";
  table?: StructuredTable;
  // 超长表格行转为记录时，完整列名与行 ID 随节点保留，子块继续携带这些上下文。
  tableRecord?: {
    tableId: string;
    rowId: string;
    columnIndex: number;
    columnName: string;
    field: "name" | "value";
    value: string;
  };
};
