// Markdown 外链图片预处理：用语法树定位图片，禁止任意文件读取和未授权网络请求。
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import type { Root, RootContent, Definition } from "mdast";

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

// 仅下载管理员允许的图片站点，禁止跳转，限制大小与请求时间。
async function loadRemoteImage(source: string): Promise<string | null> {
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    return null;
  }
  const origins = (process.env["DOCLING_MD_IMAGE_ORIGINS"] ?? "")
    .split(",")
    .map((origin) => origin.trim());
  if (url.protocol !== "https:" || url.username || url.password || !origins.includes(url.origin))
    return null;
  const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(15_000) });
  if (!response.ok || response.body === null) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.length;
      if (size > MAX_IMAGE_BYTES) throw new Error("Markdown 图片超出大小限制");
      chunks.push(next.value);
    }
    // Docling 会再次解码验证图片，Content-Type 只作为 data URI 的提示。
    return `data:${response.headers.get("content-type")?.split(";")[0] ?? "image/png"};base64,${Buffer.concat(chunks).toString("base64")}`;
  } finally {
    await reader.cancel();
  }
}

// 预加载 Markdown 图片并转成内嵌链接，引用式图片也在原位置替换，代码块不受影响。
export async function prepareMarkdownImages(
  markdown: string,
): Promise<{ markdown: string; warnings: string[] }> {
  const tree = unified().use(remarkParse).use(remarkGfm).parse(markdown);
  const definitions = new Map<string, Definition>();
  const images: RootContent[] = [];
  // 遍历真实语法节点，避免用正则误改代码示例中的图片链接。
  function visit(node: Root | RootContent): void {
    if (node.type === "definition" && !definitions.has(node.identifier.toUpperCase()))
      definitions.set(node.identifier.toUpperCase(), node);
    if (node.type === "image" || node.type === "imageReference") images.push(node);
    if ("children" in node) for (const child of node.children) visit(child);
  }
  visit(tree);
  const warnings = new Set<string>();
  const replacements: { start: number; end: number; text: string }[] = [];
  const cache = new Map<string, string | null>();
  let downloads = 0;
  for (const node of images) {
    if (node.type !== "image" && node.type !== "imageReference") continue;
    const source =
      node.type === "image" ? node.url : definitions.get(node.identifier.toUpperCase())?.url;
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (source === undefined || start === undefined || end === undefined) {
      warnings.add("markdown_image_unavailable");
      continue;
    }
    if (source.startsWith("data:image/")) continue;
    let data = cache.get(source);
    if (data === undefined) {
      data = null;
      if (downloads < 20) {
        downloads += 1;
        try {
          data = await loadRemoteImage(source);
        } catch {
          warnings.add("markdown_image_download_failed");
        }
      } else {
        warnings.add("markdown_image_download_limit_reached");
      }
      cache.set(source, data);
    }
    if (data === null) warnings.add("markdown_image_unavailable");
    // 无附件图片保留语法节点供 Docling 标记缺失，最终回填阶段移除标记。
    if (data !== null)
      replacements.push({
        start,
        end,
        text: `![${(node.alt ?? "").replace(/[\]\\[]/g, "\\$&")}](${data})`,
      });
  }
  let output = markdown;
  for (const replacement of replacements.sort((a, b) => b.start - a.start))
    output = output.slice(0, replacement.start) + replacement.text + output.slice(replacement.end);
  return { markdown: output, warnings: [...warnings] };
}
