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
from docling.datamodel.pipeline_options import PdfPipelineOptions
from docling_core.transforms.serializer.markdown import MarkdownDocSerializer, MarkdownParams, MarkdownPictureSerializer
from docling_core.transforms.serializer.common import create_ser_result

MAX_BYTES = 50 * 1024 * 1024
# 无编号的分页标记，序列化后按出现顺序补上页码。
PAGE_BREAK_PLACEHOLDER = "<!-- KNOWFLOW_PAGE_BREAK -->"
app = FastAPI(title="Knowflow Docling adapter")
conversion_lock = Lock()
pdf_options = PdfPipelineOptions(do_ocr=False, generate_picture_images=True)
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
            "pageCount": len(doc.pages) if is_pdf else None,
            "images": images,
            "warnings": sorted(set(warnings)),
        }
