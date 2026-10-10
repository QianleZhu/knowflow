import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { callModelByUsage, resolveModelConfigFromSources } from "./model-usage-client.js";

// 验证真实 SDK 请求参数：OCR 显式取消上限时不能回退到用途配置，其他调用保持配置语义。
void it("omits max_tokens for explicit null and retains configured or explicit numeric limits", async (t) => {
  const requests: Record<string, unknown>[] = [];
  t.mock.method(globalThis, "fetch", (_input: RequestInfo | URL, init?: RequestInit) => {
    const requestBody = init?.body;
    assert.ok(typeof requestBody === "string");
    requests.push(JSON.parse(requestBody) as Record<string, unknown>);
    return Promise.resolve(
      new Response(
        JSON.stringify({ choices: [{ message: { content: "识别正文" }, finish_reason: "stop" }] }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );
  });

  // 模型配置来自显式测试替身；不连接真实数据库或模型供应商。
  const resolveConfig = () =>
    Promise.resolve({
      model: "vision-test",
      temperature: 0.5,
      maxOutputTokens: 512,
      timeoutMs: 1000,
      retryCount: 0,
      baseUrl: "https://provider.example/v1",
      apiKey: "test-key",
    });
  for (const maxOutputTokens of [undefined, null, 768]) {
    const response = await callModelByUsage(
      "ocr",
      [{ role: "user", content: "识别图片" }],
      maxOutputTokens === undefined ? {} : { maxOutputTokens },
      resolveConfig,
    );
    assert.equal(response, "识别正文");
  }
  assert.equal(requests[0]?.["max_tokens"], 512);
  assert.ok(requests[1]);
  assert.ok(!("max_tokens" in requests[1]));
  assert.equal(requests[2]?.["max_tokens"], 768);
});

// 供应商因输出上限或过滤而提前结束时，OCR 必须失败，不能静默保存半页。
void it("rejects incomplete OCR responses even when the project omits max_tokens", async (t) => {
  let finishReason = "length";
  t.mock.method(globalThis, "fetch", () =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "只有半页正文" }, finish_reason: finishReason }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    ),
  );
  const resolveConfig = () =>
    Promise.resolve({
      model: "vision-test",
      temperature: 0,
      maxOutputTokens: 4000,
      timeoutMs: 1000,
      retryCount: 0,
      baseUrl: "https://provider.example/v1",
      apiKey: "test-key",
    });
  for (const reason of ["length", "content_filter"]) {
    finishReason = reason;
    await assert.rejects(
      callModelByUsage(
        "ocr",
        [{ role: "user", content: "识别" }],
        { maxOutputTokens: null },
        resolveConfig,
      ),
      /OCR 响应未完整结束/,
    );
  }
});

void describe("resolveModelConfigFromSources", () => {
  void it("tries default before fallback and uses fallback when default is unavailable", async () => {
    const requestedModelIds: string[] = [];

    const config = await resolveModelConfigFromSources("chat", {
      resolveUsagePolicy() {
        return Promise.resolve({
          defaultModelId: "default-model",
          fallbackModelId: "fallback-model",
          temperature: 0.2,
          maxOutputTokens: 512,
          timeoutMs: 3000,
          retryCount: 1,
        });
      },
      resolveCatalogModel(modelId) {
        requestedModelIds.push(modelId);
        if (modelId === "default-model") {
          return Promise.resolve(undefined);
        }
        return Promise.resolve({
          model: "qwen-fallback",
          baseUrl: "https://dashscope.example/compatible-mode/v1",
          encryptedApiKey: "encrypted-fallback",
        });
      },
      decryptApiKey(encryptedApiKey) {
        return encryptedApiKey.replace("encrypted-", "plain-");
      },
    });

    assert.deepEqual(requestedModelIds, ["default-model", "fallback-model"]);
    assert.deepEqual(config, {
      model: "qwen-fallback",
      temperature: 0.2,
      maxOutputTokens: 512,
      timeoutMs: 3000,
      retryCount: 1,
      baseUrl: "https://dashscope.example/compatible-mode/v1",
      apiKey: "plain-fallback",
    });
  });

  void it("deduplicates default and fallback model ids", async () => {
    const requestedModelIds: string[] = [];

    await resolveModelConfigFromSources("rerank", {
      resolveUsagePolicy() {
        return Promise.resolve({
          defaultModelId: "same-model",
          fallbackModelId: "same-model",
          temperature: 0.7,
          maxOutputTokens: null,
          timeoutMs: 30000,
          retryCount: 2,
        });
      },
      resolveCatalogModel(modelId) {
        requestedModelIds.push(modelId);
        return Promise.resolve({
          model: "qwen3-rerank",
          baseUrl: "https://dashscope.example/compatible-mode/v1",
          encryptedApiKey: "encrypted-key",
        });
      },
      decryptApiKey() {
        return "plain-key";
      },
    });

    assert.deepEqual(requestedModelIds, ["same-model"]);
  });

  void it("skips models with missing API keys and throws a unified configuration error", async () => {
    await assert.rejects(
      resolveModelConfigFromSources("embedding", {
        resolveUsagePolicy() {
          return Promise.resolve({
            defaultModelId: "default-model",
            fallbackModelId: "fallback-model",
            temperature: 0,
            maxOutputTokens: null,
            timeoutMs: 1000,
            retryCount: 0,
          });
        },
        resolveCatalogModel(modelId) {
          return Promise.resolve({
            model: modelId,
            baseUrl: "https://dashscope.example/compatible-mode/v1",
            encryptedApiKey: modelId === "default-model" ? null : "encrypted-empty-key",
          });
        },
        decryptApiKey() {
          return "";
        },
      }),
      /Please configure a embedding model in model settings first/,
    );
  });
});
