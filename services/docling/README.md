# Docling 文档解析适配服务

PDF、DOCX、MD 通过此服务导出有序 Markdown 和图片资源，由 TypeScript Worker 执行图片过滤、Vision 识别和原位回填。最终正文不保留图片占位符或图片链接。扫描 PDF 仍使用原截图 OCR。

Docling 只有 Python SDK，因此这里使用 Python 作为薄适配层；业务、权限、数据库和向量化仍全部使用 TypeScript。适配层不读取上传者指定的路径、不请求图片外链、不执行 Vision。

Windows 本地运行（仓库根目录）：

```powershell
python -m venv .venv-docling
.venv-docling/Scripts/python.exe -m pip install -r services/docling/requirements.txt
$env:HF_ENDPOINT='https://hf-mirror.com'
.venv-docling/Scripts/python.exe -m uvicorn services.docling.app:app --host 127.0.0.1 --port 5001
```

`HF_ENDPOINT` 用于模型下载与启动校验，详见下方「模型下载与网络」。模型缓存完整后可去掉它，改用 `HF_HUB_OFFLINE=1` 完全离线运行。

Worker 默认连接 `http://127.0.0.1:5001`，可通过 `DOCLING_URL` 修改。服务与 Worker 均设置 `DOCLING_API_KEY` 时使用请求头认证。服务只应暴露给 Worker，反向代理应限制请求体不超过 70MB。CPU 可以运行。固定的依赖版本见 requirements.txt。

**模型下载与网络。** PDF 走标准 pipeline，必须加载布局模型（`docling-project/docling-layout-heron`）与表格模型（`docling-project/docling-models`），合计约 500MB，首次解析 PDF 时下载到 `~/.cache/huggingface/hub`。DOCX/MD 走简单 pipeline，不加载任何模型，因此不受网络影响。

`huggingface.co` 在部分网络环境不可达（国内直连超时，或只放行特定域名的代理返回 502）。此时 `snapshot_download` 会抛 `httpx.ProxyError: 502 Bad Gateway`，典型表现是 **DOCX/MD 解析正常、PDF 一律 500**，与服务代码无关。处理方式：

- 启动时设置 `HF_ENDPOINT='https://hf-mirror.com'` 走镜像站（推荐，下载与校验都能通）。
- 模型缓存完整后设置 `HF_HUB_OFFLINE='1'`，完全离线运行；缓存目录可整体复制到离线机器。

首次转换有 2～3 分钟冷启动（主要是模型加载，110 页 PDF 实测 146 秒），之后同一进程内不再重复。建议让服务常驻，避免每个文档都付一次冷启动成本。排查 PDF 失败时先看服务日志：若异常栈底部是 `snapshot_download` / `api.repo_info` / `ProxyError`，即为模型未就绪，与文档内容无关。

MD 内嵌图片直接解析。HTTPS 外链图片需要管理员在 `DOCLING_MD_IMAGE_ORIGINS` 中填写可信来源（例如 `https://cdn.example.com`），禁止重定向，每张最多 20MB，每个文档最多下载 20 个来源。该配置必须只包含受信任、固定解析到公网的图片站点。相对路径图片当前缺少附件上传入口，无法读取时记录 `markdown_image_unavailable`，图片标记移除，正文继续解析。代码示例中的图片语法不会触发下载。

真实格式回归：先启动服务，再运行：

```powershell
$env:DOCLING_INTEGRATION='1'
pnpm --filter @knowflow/api exec tsx --test src/modules/domains/document/parsers/parsers.test.ts
pnpm --filter @knowflow/api exec tsx src/scripts/docling-smoke.ts
```

常规 API 测试不要求启动服务；服务协议、原位回填、重复图片、图片失败和下载安全使用独立单元测试。`docling-smoke.ts` 使用真实服务与数据库配置中的真实 OCR 模型，并断言图片描述位于前后文之间。

如果未配置 OCR，可运行 `docling-smoke.ts md --structure-only`（也支持 docx/pdf）。此模式调用真实 Docling 服务，但用明确的测试描述替身验证回填、标记清除和分块；输出 `realVision=false`，不能当作真实 OCR 验收。
