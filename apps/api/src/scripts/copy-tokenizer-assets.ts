import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// 将 Tokenizer 资源复制到发布目录，保证编译后的 API 离线可读取。
function copyTokenizerAssets(): void {
  const apiDirectory = fileURLToPath(new URL("../../", import.meta.url));
  const sourceDirectory = join(apiDirectory, "src/shared/llm/tokenizer");
  const targetDirectory = join(apiDirectory, "dist/shared/llm/tokenizer");

  mkdirSync(targetDirectory, { recursive: true });
  for (const fileName of ["qwen3-tokenizer.json.gz", "qwen3-tokenizer-config.json"]) {
    copyFileSync(join(sourceDirectory, fileName), join(targetDirectory, fileName));
  }
}

copyTokenizerAssets();
