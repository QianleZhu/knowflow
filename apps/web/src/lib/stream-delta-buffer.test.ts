import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { JSDOM } from "jsdom";
import { code } from "@streamdown/code";
import { createMathPlugin } from "@streamdown/math";
import { createElement } from "react";
import ReactMarkdown from "react-markdown";
import { renderToStaticMarkup } from "react-dom/server";
import { Streamdown } from "streamdown";
import rehypeHighlight from "rehype-highlight";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";

import { StreamDeltaBuffer, type AnimationFrameScheduler } from "./stream-delta-buffer";

type Message = { id: string; content: string };
type TestHandle = { append: (delta: string) => void };

// 为重渲染基准提供手动推进的动画帧调度器，模拟相同到达节奏。
function createManualFrameScheduler(): AnimationFrameScheduler & { runFrame: () => void } {
  const callbacks = new Map<number, () => void>();
  let nextFrameId = 0;
  return {
    request(callback) {
      const frameId = nextFrameId++;
      callbacks.set(frameId, callback);
      return frameId;
    },
    cancel(frameId) {
      callbacks.delete(frameId);
    },
    runFrame() {
      const current = [...callbacks.values()];
      callbacks.clear();
      current.forEach((callback) => callback());
    },
  };
}

// 使用真实 React DOM Profiler 比较逐 delta 更新与逐帧合并的提交次数。
async function measureCommittedRenders(useBuffer: boolean): Promise<{
  committedRenders: number;
  answer: string;
}> {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
    url: "http://localhost",
  });
  const globalNames = [
    "window",
    "document",
    "navigator",
    "HTMLElement",
    "IS_REACT_ACT_ENVIRONMENT",
  ] as const;
  const previousGlobals = new Map(
    globalNames.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]),
  );
  Object.defineProperties(globalThis, {
    window: { value: dom.window, configurable: true, writable: true },
    document: { value: dom.window.document, configurable: true, writable: true },
    navigator: { value: dom.window.navigator, configurable: true, writable: true },
    HTMLElement: { value: dom.window.HTMLElement, configurable: true, writable: true },
    IS_REACT_ACT_ENVIRONMENT: { value: true, configurable: true, writable: true },
  });

  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const frameScheduler = createManualFrameScheduler();
  const updates = { current: null as TestHandle | null };
  let committedRenders = 0;
  const messages: Message[] = Array.from({ length: 50 }, (_, index) => ({
    id: `history-${String(index)}`,
    content: `历史回答 ${String(index)}`,
  })).concat({ id: "draft-answer", content: "" });

  function MessageList() {
    const [items, setItems] = React.useState(messages);
    const buffer = React.useRef<StreamDeltaBuffer | null>(null);
    React.useEffect(() => {
      buffer.current = new StreamDeltaBuffer((messageId, delta) => {
        setItems((current) =>
          current.map((message) =>
            message.id === messageId
              ? { ...message, content: `${message.content}${delta}` }
              : message,
          ),
        );
      }, frameScheduler);
      updates.current = {
        append(delta) {
          if (useBuffer) {
            buffer.current?.append("draft-answer", delta);
          } else {
            setItems((current) =>
              current.map((message) =>
                message.id === "draft-answer"
                  ? { ...message, content: `${message.content}${delta}` }
                  : message,
              ),
            );
          }
        },
      };
      return () => buffer.current?.dispose();
    }, []);
    return React.createElement(
      "div",
      null,
      items.map((message) => React.createElement("p", { key: message.id }, message.content)),
    );
  }

  const rootElement = dom.window.document.getElementById("root");
  assert.ok(rootElement);
  const root = createRoot(rootElement);
  React.act(() => {
    root.render(
      React.createElement(
        React.Profiler,
        {
          id: "chat",
          onRender: () => {
            committedRenders += 1;
          },
        },
        React.createElement(MessageList),
      ),
    );
  });
  committedRenders = 0;

  assert.ok(updates.current);
  const updateHandle = updates.current;
  const deltas = Array.from({ length: 100 }, (_, index) => `d${String(index)},`);
  for (let frameStart = 0; frameStart < deltas.length; frameStart += 10) {
    for (const delta of deltas.slice(frameStart, frameStart + 10)) {
      React.act(() => updateHandle.append(delta));
    }
    if (useBuffer) {
      React.act(() => frameScheduler.runFrame());
    }
  }

  const answer = rootElement.textContent.split("历史回答 49").at(-1) ?? "";
  React.act(() => root.unmount());
  dom.window.close();
  for (const [name, descriptor] of previousGlobals) {
    if (descriptor === undefined) {
      Reflect.deleteProperty(globalThis, name);
    } else {
      Object.defineProperty(globalThis, name, descriptor);
    }
  }
  return { committedRenders, answer };
}

// 统计同样的渐进 Markdown 输入下，完整段落渲染器被重复调用的次数。
async function measureMarkdownBlockRenders(useStreamdown: boolean): Promise<number> {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
    url: "http://localhost",
  });
  const globalNames = [
    "window",
    "document",
    "navigator",
    "HTMLElement",
    "IS_REACT_ACT_ENVIRONMENT",
  ] as const;
  const previousGlobals = new Map(
    globalNames.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]),
  );
  Object.defineProperties(globalThis, {
    window: { value: dom.window, configurable: true, writable: true },
    document: { value: dom.window.document, configurable: true, writable: true },
    navigator: { value: dom.window.navigator, configurable: true, writable: true },
    HTMLElement: { value: dom.window.HTMLElement, configurable: true, writable: true },
    IS_REACT_ACT_ENVIRONMENT: { value: true, configurable: true, writable: true },
  });

  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const rootElement = dom.window.document.getElementById("root");
  assert.ok(rootElement);
  const root = createRoot(rootElement);
  let paragraphRenders = 0;
  let appendDelta: (delta: string) => void = () => {
    throw new Error("Markdown 测试组件尚未挂载");
  };
  const initialMarkdown = [
    ...Array.from(
      { length: 40 },
      (_, index) => `历史段落 ${String(index)}，这里有一段需要保留的完整 Markdown 内容。`,
    ),
    "正在生成",
  ].join("\n\n");
  const components = {
    p: ({ children }: { children?: React.ReactNode }) => {
      paragraphRenders += 1;
      return React.createElement("p", null, children);
    },
  };
  const plugins = {
    code,
    math: createMathPlugin({ singleDollarTextMath: true }),
  };

  function MarkdownAnswer() {
    const [markdown, setMarkdown] = React.useState(initialMarkdown);
    React.useEffect(() => {
      appendDelta = (delta) => setMarkdown((current) => `${current}${delta}`);
    }, []);
    if (useStreamdown) {
      return React.createElement(Streamdown, { mode: "streaming", plugins, components }, markdown);
    }
    return React.createElement(
      ReactMarkdown,
      {
        remarkPlugins: [remarkGfm, remarkMath],
        rehypePlugins: [rehypeKatex, rehypeHighlight],
        components,
      },
      markdown,
    );
  }

  React.act(() => root.render(React.createElement(MarkdownAnswer)));
  paragraphRenders = 0;
  for (let index = 0; index < 20; index += 1) {
    React.act(() => appendDelta("a"));
  }
  const renderCount = paragraphRenders;
  React.act(() => root.unmount());
  dom.window.close();
  for (const [name, descriptor] of previousGlobals) {
    if (descriptor === undefined) Reflect.deleteProperty(globalThis, name);
    else Object.defineProperty(globalThis, name, descriptor);
  }
  return renderCount;
}

void describe("流式 delta 动画帧缓存", () => {
  void it("合并一帧内的增量并在显式 flush 时保留完整文本", () => {
    const scheduler = createManualFrameScheduler();
    const flushed: string[] = [];
    const buffer = new StreamDeltaBuffer((messageId, delta) => {
      flushed.push(`${messageId}:${delta}`);
    }, scheduler);

    buffer.append("answer", "首段");
    buffer.append("answer", "尾段");
    buffer.flush();

    assert.deepEqual(flushed, ["answer:首段尾段"]);
    scheduler.runFrame();
    assert.equal(flushed.length, 1);
  });

  void it("在相同输入节奏下让 React 提交从 100 次降到 10 次", async () => {
    const before = await measureCommittedRenders(false);
    const after = await measureCommittedRenders(true);

    assert.equal(before.committedRenders, 100);
    assert.equal(after.committedRenders, 10);
    assert.equal(before.answer, after.answer);
    assert.equal(
      after.answer,
      Array.from({ length: 100 }, (_, index) => `d${String(index)},`).join(""),
    );
  });
});

// 验证 Streamdown 能在服务端渲染阶段修复流末尾尚未闭合的 Markdown。
void describe("Streamdown 增量 Markdown 渲染", () => {
  // 流尾缺少闭合标记时仍按加粗语义输出，而不是把标记显示给用户。
  void it("renders an unterminated bold span as formatted text", () => {
    const markup = renderToStaticMarkup(
      createElement(
        Streamdown,
        {
          mode: "streaming",
          plugins: {
            code,
            math: createMathPlugin({ singleDollarTextMath: true }),
          },
          skipHtml: true,
        },
        "正在生成 **尚未闭合的加粗文本",
      ),
    );

    assert.match(markup, /data-streamdown="strong">尚未闭合的加粗文本<\/span>/u);
  });

  // 只追加最后一个段落时，验证已完成的 Markdown 段落不再逐次重渲染。
  void it("re-renders fewer unchanged paragraphs while the final block streams", async () => {
    const before = await measureMarkdownBlockRenders(false);
    const after = await measureMarkdownBlockRenders(true);

    console.log(
      `Markdown 段落组件调用次数：react-markdown ${String(before)}，Streamdown ${String(after)}`,
    );
    assert.ok(before >= 800);
    assert.ok(after <= 40);
  });
});
