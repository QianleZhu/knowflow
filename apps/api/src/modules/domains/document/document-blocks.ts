// Docling 从文档树导出的最小结构块协议，供解析器与切块器共享。
export type ParsedContentBlock = {
  kind: "heading" | "paragraph" | "list" | "table" | "code" | "picture" | "other";
  markdown: string;
  level: number | null;
  pageNumbers: number[];
};
