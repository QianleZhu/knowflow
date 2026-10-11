import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";

import { Tokenizer } from "@huggingface/tokenizers";

export type QwenChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

const TOKENIZER_PATH = fileURLToPath(
  new URL("./tokenizer/qwen3-tokenizer.json.gz", import.meta.url),
);
const TOKENIZER_CONFIG_PATH = fileURLToPath(
  new URL("./tokenizer/qwen3-tokenizer-config.json", import.meta.url),
);

let cachedTokenizer: Tokenizer | null = null;

// 使用随服务发布的 Qwen3 Tokenizer 资源，避免运行时依赖外网下载。
function getTokenizer(): Tokenizer {
  if (cachedTokenizer !== null) return cachedTokenizer;

  const tokenizerJson = JSON.parse(
    gunzipSync(readFileSync(TOKENIZER_PATH)).toString("utf8"),
  ) as object;
  const tokenizerConfig = JSON.parse(readFileSync(TOKENIZER_CONFIG_PATH, "utf8")) as object;
  cachedTokenizer = new Tokenizer(tokenizerJson, tokenizerConfig);
  return cachedTokenizer;
}

// 按 Qwen ChatML 消息边界估算整份对话请求的输入 Token 数。
export function countQwenChatTokens(messages: QwenChatMessage[]): number {
  const serializedMessages = messages
    .map(({ role, content }) => `<|im_start|>${role}\n${content}<|im_end|>\n`)
    .join("");
  const requestText = `${serializedMessages}<|im_start|>assistant\n`;
  return getTokenizer().encode(requestText, { add_special_tokens: false }).ids.length;
}
