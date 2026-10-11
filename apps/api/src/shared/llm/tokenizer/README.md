# Qwen Tokenizer 资源

`qwen3-tokenizer.json.gz` 与 `qwen3-tokenizer-config.json` 来自 `Qwen/Qwen3-4B`，固定在 Hugging Face revision `eb971e9fb1f41c13b5e5a56e56886305c5ad94a0`。该仓库采用 Apache-2.0 许可证，许可证文本见本目录的 `LICENSE-APACHE-2.0.txt`。

服务使用 `@huggingface/tokenizers` 在本地估算 Qwen ChatML 请求 Token 数，不会在运行时下载模型文件。此估算用于压缩决策；运行追踪同时记录服务端返回的实际输入/输出 Token 数。
