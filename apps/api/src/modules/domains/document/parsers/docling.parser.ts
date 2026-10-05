// Docling 结构转换与图片原位回填：最终正文只保留识别文字，不保留图片标记。
import { createHash } from "node:crypto";
import { imageSize } from "image-size";
import { toParsedDocument } from "./cleaner.js";
import { formatPageMarker } from "../document-text-structure.js";
import { prepareMarkdownImages } from "./markdown-images.js";
import type { ParsedDocument, VisionImageInput, VisionBudget, VisionStats } from "./types.js";
import {
  describeImageWithVision,
  newVisionBudget,
  newVisionStats,
  pushUniqueWarning,
  visionStatsMetadata,
} from "./vision-ocr.js";

export type DoclingResult = {
  nonce: string;
  pages: { pageNumber: number | null; markdown: string }[];
  // 一次序列化整篇后页码不再按页拆分，由适配层单独给出总页数；旧版本没有此字段。
  pageCount?: number | null;
  images: { marker: string; base64: string }[];
  warnings: string[];
};
type ImageDescriber = (
  image: VisionImageInput,
  budget: VisionBudget,
  stats: VisionStats,
) => Promise<string | null>;
const MAX_RESPONSE_BYTES = 150 * 1024 * 1024;

// 检查解析服务响应，禁止把损坏的协议或图片资源写入文档。
function validateResult(value: unknown): DoclingResult {
  if (typeof value !== "object" || value === null) throw new Error("Docling 返回了无效响应");
  const result = value as Record<string, unknown>;
  if (
    typeof result["nonce"] !== "string" ||
    !/^[a-f0-9]{32}$/.test(result["nonce"]) ||
    !Array.isArray(result["pages"]) ||
    result["pages"].length === 0 ||
    !Array.isArray(result["images"]) ||
    !Array.isArray(result["warnings"])
  ) {
    throw new Error("Docling 返回格式不匹配，请检查适配服务版本");
  }
  for (const page of result["pages"] as unknown[]) {
    if (
      typeof page !== "object" ||
      page === null ||
      !("markdown" in page) ||
      typeof page.markdown !== "string" ||
      !("pageNumber" in page) ||
      (page.pageNumber !== null &&
        (!Number.isSafeInteger(page.pageNumber) || Number(page.pageNumber) < 1))
    ) {
      throw new Error("Docling 返回了无效分页内容");
    }
  }
  for (const image of result["images"] as unknown[]) {
    if (
      typeof image !== "object" ||
      image === null ||
      !("marker" in image) ||
      typeof image.marker !== "string" ||
      !new RegExp(`^<!-- KNOWFLOW_IMAGE:${result["nonce"]}:\\d+ -->$`).test(image.marker) ||
      !("base64" in image) ||
      typeof image.base64 !== "string" ||
      image.base64.length > 28 * 1024 * 1024 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(image.base64)
    ) {
      throw new Error("Docling 返回了无效图片资源");
    }
  }
  const pageCount = result["pageCount"];
  if (
    pageCount !== undefined &&
    pageCount !== null &&
    (!Number.isSafeInteger(pageCount) || (pageCount as number) < 1)
  )
    throw new Error("Docling 返回了无效页数");
  if (!(result["warnings"] as unknown[]).every((warning) => typeof warning === "string"))
    throw new Error("Docling 告警格式错误");
  return value as DoclingResult;
}

// 读取有大小限制的服务响应，避免大型 Base64 输出耗尽 Worker 内存。
async function readResponse(response: Response): Promise<unknown> {
  if (response.body === null) throw new Error("Docling 返回空响应");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.length;
      if (length > MAX_RESPONSE_BYTES) throw new Error("Docling 响应超过大小上限");
      chunks.push(next.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } finally {
    await reader.cancel();
  }
}

// 调用独立 Docling 适配服务；服务失败显式终止，不能回退到图片页尾追加。
export async function parseDoclingDocument(
  buffer: Buffer,
  format: "pdf" | "docx" | "md",
): Promise<ParsedDocument> {
  const prepared = format === "md" ? await prepareMarkdownImages(buffer.toString("utf8")) : null;
  const endpoint = new URL(
    "convert",
    `${(process.env["DOCLING_URL"] ?? "http://127.0.0.1:5001").replace(/\/$/, "")}/`,
  );
  if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:")
    throw new Error("DOCLING_URL 必须使用 HTTP 或 HTTPS");
  let result: DoclingResult;
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(300_000),
      headers: {
        "Content-Type": "application/json",
        ...(process.env["DOCLING_API_KEY"] ? { "X-Api-Key": process.env["DOCLING_API_KEY"] } : {}),
      },
      body: JSON.stringify({
        format,
        base64: (prepared === null ? buffer : Buffer.from(prepared.markdown)).toString("base64"),
      }),
    });
    if (!response.ok) throw new Error(`Docling 转换失败（HTTP ${String(response.status)}）`);
    result = validateResult(await readResponse(response));
  } catch (error) {
    throw new Error(
      `文档结构解析失败，请检查 Docling 服务：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  result.warnings.push(...(prepared?.warnings ?? []));
  return backfillDoclingImages(result, format);
}

// 在每个图片节点原位插入描述，按字节缓存相同图片，保留原始标题层级与页码。
export async function backfillDoclingImages(
  result: DoclingResult,
  format: "pdf" | "docx" | "md",
  describe: ImageDescriber = describeImageWithVision,
): Promise<ParsedDocument> {
  const stats = newVisionStats();
  const budget = newVisionBudget();
  const cache = new Map<string, string>();
  const images = new Map(result.images.map((image) => [image.marker, image]));
  const markerPattern = new RegExp(`<!-- KNOWFLOW_IMAGE:${result.nonce}:\\d+ -->`, "g");
  const pages: string[] = [];
  for (const page of result.pages) {
    const markdown = page.markdown;
    const parts: string[] = [];
    let position = 0;
    for (const match of markdown.matchAll(markerPattern)) {
      parts.push(markdown.slice(position, match.index));
      position = match.index + match[0].length;
      const image = images.get(match[0]);
      if (image === undefined) {
        pushUniqueWarning(stats, "docling_image_unavailable");
        continue;
      }
      const bytes = Buffer.from(image.base64, "base64");
      const hash = createHash("sha256").update(bytes).digest("hex");
      let description = cache.get(hash);
      if (description === undefined) {
        try {
          // 尺寸和类型均从实际字节读取，不信任服务声称的图片格式。
          const dimensions = imageSize(bytes);
          description =
            (await describe(
              {
                buffer: bytes,
                mimeType:
                  dimensions.type === "jpg" ? "image/jpeg" : `image/${dimensions.type ?? "png"}`,
                sourceLabel: "文档图片",
                width: dimensions.width,
                height: dimensions.height,
                skipDecorative: true,
              },
              budget,
              stats,
            )) ?? "";
        } catch {
          stats.failed += 1;
          pushUniqueWarning(stats, "docling_image_invalid");
          description = "";
        }
        cache.set(hash, description);
      }
      // 用字符串片段拼接，识别结果中的 $& 等字符不会触发替换语义。
      parts.push(description);
    }
    parts.push(markdown.slice(position));
    pages.push(
      [
        format !== "pdf" || page.pageNumber === null ? "" : formatPageMarker(page.pageNumber),
        parts.join(""),
      ]
        .filter(Boolean)
        .join("\n\n"),
    );
  }
  return toParsedDocument(pages.join("\n\n"), "docling", {
    ...(format === "pdf" ? { pdfPageCount: result.pageCount ?? result.pages.length } : {}),
    ...(format === "docx" ? { originalFormat: "docx" as const } : {}),
    ...visionStatsMetadata(stats),
    ...(result.warnings.length > 0 ? { parserWarnings: [...new Set(result.warnings)] } : {}),
  });
}
