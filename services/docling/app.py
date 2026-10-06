# Docling 的 Python SDK 薄适配层：只转换文档和导出图片，业务处理留在 TypeScript。
import base64
import hmac
import os
import re
from io import BytesIO
from threading import Lock
from uuid import uuid4

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel, Field
from docling.document_converter import DocumentConverter, PdfFormatOption, MarkdownFormatOption
from docling.datamodel.base_models import DocumentStream, InputFormat, ConversionStatus
from docling.datamodel.backend_options import MarkdownBackendOptions
from docling.datamodel.pipeline_options import PdfPipelineOptions, HeadingHierarchyOptions
from docling_core.transforms.serializer.markdown import MarkdownDocSerializer, MarkdownParams, MarkdownPictureSerializer
from docling_core.transforms.serializer.common import create_ser_result

MAX_BYTES = 50 * 1024 * 1024
# 无编号的分页标记，序列化后按出现顺序补上页码。
PAGE_BREAK_PLACEHOLDER = "<!-- KNOWFLOW_PAGE_BREAK -->"
app = FastAPI(title="Knowflow Docling adapter")
conversion_lock = Lock()
pdf_options = PdfPipelineOptions(do_ocr=False, generate_picture_images=True)
# 使用 Docling 正式的标题层级推断阶段，字体推断需要保留解析页面信息。
pdf_options.heading_hierarchy_options = HeadingHierarchyOptions(enabled=True)
pdf_options.generate_parsed_pages = True
# 禁止文档指示解析服务读取任意本地文件或请求内网；只允许内嵌图片。
converter = DocumentConverter(
    allowed_formats=[InputFormat.PDF, InputFormat.DOCX, InputFormat.MD],
    format_options={
        InputFormat.PDF: PdfFormatOption(pipeline_options=pdf_options),
        InputFormat.MD: MarkdownFormatOption(backend_options=MarkdownBackendOptions(
            fetch_images=True, enable_local_fetch=False, enable_remote_fetch=False,
        )),
    },
)


# 限制单次输入大小，并使用服务内部固定文件名识别格式。
class ConvertRequest(BaseModel):
    format: str = Field(pattern=r"^(pdf|docx|md)$")
    base64: str = Field(max_length=(MAX_BYTES * 4 // 3) + 4)


# 根据图片节点引用生成唯一标记，避免相同图片或跨页图片错配。
class IndexedPictureSerializer(MarkdownPictureSerializer):
    # 使用节点索引替换标记模板，不改变官方序列化器的正文顺序。
    def _serialize_image_part(self, item, doc, image_mode, image_placeholder, **kwargs):
        index = item.self_ref.rsplit("/", 1)[-1]
        return create_ser_result(text=image_placeholder.replace("{index}", index), span_source=item)


# 分页标记落在两页之间，因此第 n 个标记代表第 n+1 页，开头另补第 1 页。
def number_page_breaks(markdown: str) -> str:
    counter = 1

    def replace(_match: re.Match[str]) -> str:
        nonlocal counter
        counter += 1
        return f"<!-- KNOWFLOW_PAGE_BREAK:{counter} -->"

    return f"<!-- KNOWFLOW_PAGE_BREAK:1 -->\n\n" + re.sub(
        re.escape(PAGE_BREAK_PLACEHOLDER), replace, markdown
    )


# 按 Docling 文档树顺序导出最小结构块，并把页码留在各自节点上。
def serialize_structured_blocks(doc, serializer, is_pdf: bool) -> list[dict]:
    blocks = []
    for item, level in doc.iterate_items(with_groups=False, traverse_pictures=True):
        label = getattr(getattr(item, "label", None), "value", "")
        # 页眉页脚是版面元素，不作为正文或独立章节参与切分。
        if label in {"page_header", "page_footer"}:
            continue
        if label == "section_header":
            kind = "heading"
            heading_level = getattr(item, "level", 1)
        elif label == "title":
            kind = "heading"
            heading_level = 1
        elif label in {"table", "document_index"}:
            kind = "table"
            heading_level = None
        elif label == "list_item":
            kind = "list"
            heading_level = None
        elif label == "code":
            kind = "code"
            heading_level = None
        elif label in {"picture", "chart"}:
            kind = "picture"
            heading_level = None
        elif label in {"text", "paragraph", "caption", "footnote", "formula", "handwritten_text"}:
            kind = "paragraph"
            heading_level = None
        else:
            kind = "other"
            heading_level = None

        # 复用官方 Markdown serializer，保留表格、代码块、列表和图片占位符格式。
        markdown = serializer.serialize(item=item, list_level=level).text.strip()
        if not markdown:
            continue
        # SectionHeaderItem.level 可能从文档标题之后重新计数，结构块层级统一对齐序列化结果。
        if kind == "heading":
            heading_match = re.match(r"^(#{1,6})\s+", markdown)
            if heading_match is not None:
                heading_level = len(heading_match.group(1))
        pages = sorted({
            provenance.page_no
            for provenance in getattr(item, "prov", [])
            if is_pdf
            if isinstance(getattr(provenance, "page_no", None), int)
            and provenance.page_no > 0
        })
        source = {"blockId": item.self_ref, "pageNumbers": pages, "precision": "block"}
        block = {
            "kind": kind,
            "markdown": markdown,
            "level": heading_level,
            "pageNumbers": pages,
            "sources": [source],
        }
        if kind == "table" and getattr(item, "data", None) is not None:
            block["table"] = serialize_table(item, doc, serializer, source, is_pdf)
        blocks.append(block)
    return blocks


# 导出表格单元格与行来源；普通 TableCell 不含 page_no，跨页节点只能声明块级精度。
def serialize_table(item, doc, serializer, source: dict, is_pdf: bool) -> dict:
    rows = []
    header_rows = []
    for row_index, cells in enumerate(item.data.grid):
        row_id = f"{item.self_ref}:row:{row_index + 1}"
        output_cells = []
        for column_index, cell in enumerate(cells):
            reference = getattr(cell, "ref", None)
            child = reference.resolve(doc) if reference is not None else None
            text = serializer.serialize(item=child).text if child is not None else cell.text
            cell_pages = sorted({prov.page_no for prov in getattr(child, "prov", []) if is_pdf and prov.page_no > 0})
            precise = bool(cell_pages) or len(source["pageNumbers"]) == 1
            cell_source = {**source, "blockId": f"{row_id}:cell:{column_index + 1}",
                           "pageNumbers": cell_pages or source["pageNumbers"],
                           "precision": "cell" if precise else "block", "rowStart": row_index + 1,
                           "rowEnd": row_index + 1}
            output_cells.append({"text": text, "sources": [cell_source]})
        row = {"id": row_id, "cells": output_cells,
               "sources": [cell_source for cell in output_cells for cell_source in cell["sources"]]}
        if cells and all(cell.column_header for cell in cells):
            header_rows.append(row)
        else:
            rows.append(row)
    if header_rows:
        # 多层表头合并为完整列路径，原表头坐标继续保留。
        header = {"id": f"{item.self_ref}:header", "sources": [src for row in header_rows for src in row["sources"]],
                  "cells": [{"text": " / ".join(dict.fromkeys(row["cells"][column]["text"] for row in header_rows)),
                             "sources": [src for row in header_rows for src in row["cells"][column]["sources"]]}
                            for column in range(item.data.num_cols)]}
    else:
        # 未标注表头时不能吞掉第一条数据，用占位列名承载表格结构。
        header = {"id": f"{item.self_ref}:header", "sources": [],
                  "cells": [{"text": f"列 {column + 1}", "sources": []} for column in range(item.data.num_cols)]}
    return {"header": header, "rows": rows}


# 仅返回健康状态，不暴露模型或运行配置。
@app.get("/health")
def health():
    return {"status": "ok"}


# 接收文档字节，返回带位置标记的 Markdown 和 PNG 图片字节。
@app.post("/convert")
def convert(request: ConvertRequest, x_api_key: str | None = Header(default=None)):
    key = os.getenv("DOCLING_API_KEY", "")
    if key and not hmac.compare_digest(x_api_key or "", key):
        raise HTTPException(status_code=401, detail="Unauthorized")
    try:
        raw = base64.b64decode(request.base64, validate=True)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid base64") from None
    if not raw or len(raw) > MAX_BYTES:
        raise HTTPException(status_code=413, detail="Invalid document size")
    # 单实例串行转换，避免多个重型模型任务同时耗尽内存。
    with conversion_lock:
        result = converter.convert(DocumentStream(name=f"document.{request.format}", stream=BytesIO(raw)))
        if result.status != ConversionStatus.SUCCESS:
            raise HTTPException(status_code=422, detail="Document conversion did not succeed")
        doc = result.document
        nonce = uuid4().hex
        placeholder = f"<!-- KNOWFLOW_IMAGE:{nonce}:{{index}} -->"
        # 一次序列化整篇：逐页序列化会把同一棵树重建上百次，实测慢两个数量级。
        # PDF 用原生分页标记保留页码；Word/MD 不制造物理页码。
        is_pdf = request.format == "pdf"
        params = MarkdownParams(
            image_placeholder=placeholder,
            page_break_placeholder=PAGE_BREAK_PLACEHOLDER if is_pdf else None,
        )
        serializer = MarkdownDocSerializer(
            doc=doc, picture_serializer=IndexedPictureSerializer(), params=params
        )
        markdown = serializer.serialize().text
        # 父块切分使用 Docling 节点与来源页码，不再从整篇 Markdown 反向匹配字符串。
        structured_blocks = serialize_structured_blocks(doc, serializer, is_pdf)
        if is_pdf:
            markdown = number_page_breaks(markdown)
        images = []
        warnings = []
        for picture in doc.pictures:
            marker = placeholder.replace("{index}", picture.self_ref.rsplit("/", 1)[-1])
            try:
                image = picture.get_image(doc)
                if image is None:
                    warnings.append("docling_image_unavailable")
                    continue
                output = BytesIO()
                image.save(output, format="PNG")
                images.append({"marker": marker, "base64": base64.b64encode(output.getvalue()).decode("ascii")})
            except (ValueError, OSError):
                warnings.append("docling_image_extract_failed")
        return {
            "nonce": nonce,
            "pages": [{"pageNumber": None, "markdown": markdown}],
            "blocks": structured_blocks,
            "pageCount": len(doc.pages) if is_pdf else None,
            "images": images,
            "warnings": sorted(set(warnings)),
        }
