import {
  HelpCircle,
  AlertTriangle,
  Compass,
  ShieldAlert,
  AlertCircle,
  Bot,
  BookOpenText,
} from "lucide-react";
import { code } from "@streamdown/code";
import { createMathPlugin } from "@streamdown/math";
import { Streamdown, type Components, defaultUrlTransform } from "streamdown";
import { type SyntheticEvent, useState } from "react";

import {
  type AgentTraceSummary,
  type ConversationMessage,
  type FeedbackRating,
  type NoAnswerType,
} from "@knowflow/shared";

import { Button } from "../../components/ui/button";
import { Checkbox } from "../../components/ui/checkbox";
import { Dialog } from "../../components/ui/dialog";
import { cn } from "../../lib/cn";

// 固定插件实例，避免流式更新时因配置对象变化而让已解析块失去缓存。
const MARKDOWN_PLUGINS = {
  code,
  math: createMathPlugin({ singleDollarTextMath: true }),
};

// 保留当前聊天答案的排版样式，并让链接继续使用安全的新窗口行为。
const MARKDOWN_COMPONENTS: Components = {
  // 为段落保留聊天正文的紧凑行距。
  p: (props) => {
    const { node: _node, ...rest } = props;
    void _node;
    return <p className="mb-2 last:mb-0" {...rest} />;
  },
  // 为无序列表保留清楚的缩进和条目间距。
  ul: (props) => {
    const { node: _node, ...rest } = props;
    void _node;
    return <ul className="mb-2 ml-5 list-disc space-y-1" {...rest} />;
  },
  // 为有序列表保留清楚的缩进和条目间距。
  ol: (props) => {
    const { node: _node, ...rest } = props;
    void _node;
    return <ol className="mb-2 ml-5 list-decimal space-y-1" {...rest} />;
  },
  // 让列表项沿用浏览器语义和 Streamdown 的安全处理。
  li: (props) => {
    const { node: _node, ...rest } = props;
    void _node;
    return <li {...rest} />;
  },
  // 为一级标题保留答案内标题的层级和间距。
  h1: (props) => {
    const { node: _node, ...rest } = props;
    void _node;
    return <h1 className="mb-3 mt-5 text-xl font-bold text-ink" {...rest} />;
  },
  // 为二级标题保留答案内标题的层级和间距。
  h2: (props) => {
    const { node: _node, ...rest } = props;
    void _node;
    return <h2 className="mb-3 mt-4 text-lg font-bold text-ink" {...rest} />;
  },
  // 为三级标题保留答案内标题的层级和间距。
  h3: (props) => {
    const { node: _node, ...rest } = props;
    void _node;
    return <h3 className="mb-2 mt-4 text-base font-semibold text-ink" {...rest} />;
  },
  // 为四级标题保留答案内标题的层级和间距。
  h4: (props) => {
    const { node: _node, ...rest } = props;
    void _node;
    return <h4 className="mb-2 mt-3 text-sm font-semibold text-ink" {...rest} />;
  },
  // 限制答案链接的跳转上下文，避免新页面取得当前窗口引用。
  a: (props) => {
    const { node: _node, ...rest } = props;
    void _node;
    return (
      <a
        className="font-medium text-brand-600 underline underline-offset-4 transition-colors hover:text-brand-700"
        target="_blank"
        rel="noopener noreferrer"
        {...rest}
      />
    );
  },
  // 为强调文本保留品牌正文颜色。
  strong: (props) => {
    const { node: _node, ...rest } = props;
    void _node;
    return <strong className="font-bold text-ink" {...rest} />;
  },
  // 为代码块保留横向滚动容器和浅色背景。
  pre: (props) => {
    const { node: _node, ...rest } = props;
    void _node;
    return (
      <pre
        className="my-4 overflow-x-auto rounded-xl border border-border/80 bg-neutral-50 p-4 text-sm shadow-sm"
        {...rest}
      />
    );
  },
  // 为行内代码保留紧凑底色，同时不覆盖代码插件的语法颜色。
  code: (props) => {
    const { node: _node, className, children, ...rest } = props;
    void _node;
    return !className ? (
      <code
        className="rounded-md border border-border/50 bg-neutral-100/80 px-1.5 py-0.5 font-mono text-sm text-brand-700"
        {...rest}
      >
        {children}
      </code>
    ) : (
      <code className={className} {...rest}>
        {children}
      </code>
    );
  },
};

export type DraftAssistantMessage = {
  id: string;
  conversationId: string;
  role: "assistant";
  content: string;
  noAnswerType: NoAnswerType | null;
  sources: ConversationMessage["sources"];
  recommendedQuestions: string[];
  createdAt: string;
  completionState?: "cancelled" | "failed";
};

export type DisplayMessage = ConversationMessage | DraftAssistantMessage;

export const noAnswerMeta: Record<
  NoAnswerType,
  {
    label: string;
    description: string;
    bgCls: string;
    textCls: string;
    icon: React.ComponentType<{ className?: string }>;
  }
> = {
  no_answer: {
    label: "无匹配答案",
    description: "未在知识库中找到相关内容。",
    bgCls: "bg-neutral-50 border border-border",
    textCls: "text-ink-muted",
    icon: HelpCircle,
  },
  low_confidence: {
    label: "回答可信度较低",
    description: "此回答依据不足，可信度较低，请谨慎参考。",
    bgCls: "bg-warning-bg border border-warning/20",
    textCls: "text-warning",
    icon: AlertTriangle,
  },
  knowledge_gap: {
    label: "知识库空白",
    description: "知识库中尚无相关内容，无法回答该问题。",
    bgCls: "bg-info-bg border border-info/20",
    textCls: "text-info",
    icon: Compass,
  },
  permission_limited: {
    label: "权限受限",
    description: "受权限限制，无法读取与此问题相关的知识库文档。",
    bgCls: "bg-danger-bg border border-danger/20",
    textCls: "text-danger",
    icon: ShieldAlert,
  },
  attachment_parse_failed: {
    label: "附件解析失败",
    description: "上传的附件解析失败，无法提取有效信息进行回答。",
    bgCls: "bg-danger-bg border border-danger/20",
    textCls: "text-danger",
    icon: AlertCircle,
  },
};

// 在用户查询旁显示失败运行的详情入口；成功运行入口放在对应助手回答上。
export function UserBubble({
  content,
  trace,
  onOpenTrace,
}: {
  content: string;
  trace?: AgentTraceSummary | undefined;
  onOpenTrace?: (() => void) | undefined;
}) {
  return (
    <div className="flex flex-col items-end gap-1 animate-in fade-in slide-in-from-bottom-2 duration-300 ease-out fill-mode-both">
      <div className="max-w-[80%] rounded-2xl rounded-tr-sm bg-brand-600 px-4 py-2.5 text-base whitespace-pre-wrap text-white shadow-sm shadow-brand-500/20">
        {content}
      </div>
      {trace !== undefined && onOpenTrace !== undefined ? (
        <button
          type="button"
          onClick={onOpenTrace}
          className="rounded-md px-2 py-1 text-xs text-ink-subtle transition-colors hover:bg-neutral-100 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
        >
          {trace.status === "cancelled" ? "查看已停止运行详情" : "查看失败运行详情"}
        </button>
      ) : null}
    </div>
  );
}

// 渲染助手回答、流式 Markdown、运行状态和消息操作。
export function AssistantBubble({
  message,
  isStreaming,
  statusText,
  feedback,
  onFeedback,
  onCorrection,
  onRegenerate,
  onAskRecommended,
  trace,
  onOpenTrace,
}: {
  message: DisplayMessage;
  isStreaming: boolean;
  statusText: string;
  feedback: FeedbackRating | undefined;
  onFeedback: (rating: FeedbackRating) => void;
  onCorrection: () => void;
  onRegenerate: () => void;
  onAskRecommended: (q: string) => void;
  trace?: AgentTraceSummary | undefined;
  onOpenTrace?: (() => void) | undefined;
}) {
  const showSkeleton = isStreaming && message.content === "";
  const isPartialAnswer = "completionState" in message;
  return (
    <div className="flex flex-col gap-2 animate-in fade-in slide-in-from-bottom-2 duration-300 ease-out fill-mode-both">
      <div className="flex items-start gap-3">
        <div className="mt-1 flex size-8 shrink-0 items-center justify-center rounded-full bg-brand-100 text-brand-700 ring-1 ring-brand-500/20 shadow-sm">
          <Bot className="size-4.5" />
        </div>
        <div className="min-w-0 flex-1">
          {/* noAnswerType 提示 */}
          {!showSkeleton && message.noAnswerType
            ? (() => {
                const meta = noAnswerMeta[message.noAnswerType];
                const Icon = meta.icon;
                return (
                  <div
                    className={cn(
                      "mb-3 flex items-start gap-2.5 rounded-lg border p-3 text-sm transition-all shadow-xs",
                      meta.bgCls,
                    )}
                  >
                    <Icon className={cn("mt-0.5 size-4 shrink-0", meta.textCls)} />
                    <div className="flex-1">
                      <span className={cn("font-semibold block", meta.textCls)}>{meta.label}</span>
                      <span className="text-ink-muted text-xs mt-0.5 block">
                        {meta.description}
                      </span>
                    </div>
                  </div>
                );
              })()
            : null}

          {showSkeleton ? (
            <p className="flex items-center gap-2 text-sm text-ink-muted">
              <span className="inline-flex gap-1" aria-hidden>
                <span className="size-1.5 animate-pulse rounded-full bg-brand-400" />
                <span className="size-1.5 animate-pulse rounded-full bg-brand-400 [animation-delay:0.2s]" />
                <span className="size-1.5 animate-pulse rounded-full bg-brand-400 [animation-delay:0.4s]" />
              </span>
              {statusText || "思考中"}
            </p>
          ) : (
            <div className="text-base leading-relaxed text-ink">
              <Streamdown
                mode={isStreaming || isPartialAnswer ? "streaming" : "static"}
                isAnimating={isStreaming}
                plugins={MARKDOWN_PLUGINS}
                components={MARKDOWN_COMPONENTS}
                skipHtml
                urlTransform={defaultUrlTransform}
              >
                {message.content}
              </Streamdown>
            </div>
          )}

          {/* 答案下方展示实际进入模型上下文的父块标题路径。 */}
          {!showSkeleton && !isPartialAnswer && message.sources.length > 0 ? (
            <section className="mt-4" aria-label="回答来源">
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-subtle">
                参考来源
              </h3>
              <ul className="grid gap-2 sm:grid-cols-2">
                {message.sources.map((source) => (
                  <li
                    key={source.id}
                    className="min-w-0 rounded-lg border border-border bg-neutral-0 px-3 py-2.5"
                  >
                    <div className="flex min-w-0 items-start gap-2">
                      <BookOpenText className="mt-0.5 size-4 shrink-0 text-brand-600" aria-hidden />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-ink">{source.title}</p>
                        <p className="mt-0.5 truncate text-xs text-ink-subtle">
                          {source.knowledgeBaseName}
                          {source.sourceType === "knowledge_item" ? " · 知识条目" : " · 文档"}
                        </p>
                        <p className="mt-1 break-words text-xs leading-relaxed text-ink-muted">
                          {source.headingPath.length > 0
                            ? source.headingPath.join(" › ")
                            : source.sourceType === "knowledge_item"
                              ? "知识条目正文"
                              : "未标注标题路径"}
                        </p>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {isPartialAnswer ? (
            <p className="mt-2 text-xs text-warning" role="status">
              {message.completionState === "cancelled"
                ? "已停止生成；已输出内容保存在运行记录中。"
                : "生成未完成；已输出内容保存在运行记录中。"}
            </p>
          ) : null}

          {isPartialAnswer ? (
            <div className="mt-2 flex items-center gap-1">
              <IconAction
                label="复制部分内容"
                onClick={() => void navigator.clipboard.writeText(message.content)}
              />
              <IconAction label="重新提问" onClick={() => onRegenerate()} />
            </div>
          ) : null}

          {/* 操作按钮 */}
          {!message.id.startsWith("draft-") && !isPartialAnswer ? (
            <div className="mt-2 flex items-center gap-1">
              <IconAction
                label="复制"
                onClick={() => void navigator.clipboard.writeText(message.content)}
              />
              {trace !== undefined && onOpenTrace !== undefined ? (
                <IconAction label="运行详情" onClick={onOpenTrace} />
              ) : null}
              <IconAction label="重新生成" onClick={onRegenerate} />
              <IconAction
                label="赞"
                active={feedback === "useful"}
                disabled={feedback !== undefined}
                onClick={() => onFeedback("useful")}
              />
              <IconAction
                label="踩"
                active={feedback === "not_useful"}
                disabled={feedback !== undefined}
                onClick={() => onFeedback("not_useful")}
              />
              <IconAction label="纠错" onClick={onCorrection} />
              {feedback !== undefined ? (
                <span className="ml-1 text-xs text-ink-subtle">已反馈</span>
              ) : null}
            </div>
          ) : null}

          {/* 推荐问题 */}
          {message.recommendedQuestions.length > 0 ? (
            <div className="mt-3 flex flex-wrap gap-2">
              {message.recommendedQuestions.map((q, i) => (
                <button
                  key={`${String(i)}-${q}`}
                  type="button"
                  onClick={() => onAskRecommended(q)}
                  className="rounded-full border border-border bg-neutral-0 px-3 py-1 text-sm text-ink-muted transition-colors hover:border-brand-300 hover:text-brand-700"
                >
                  {q}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export function IconAction({
  label,
  onClick,
  active = false,
  disabled = false,
}: {
  label: string;
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "rounded-md px-2 py-1 text-xs transition-colors duration-150",
        active
          ? "bg-brand-50 text-brand-700"
          : "text-ink-subtle hover:bg-neutral-100 hover:text-ink",
        disabled && !active ? "cursor-not-allowed opacity-50" : "",
      )}
    >
      {label}
    </button>
  );
}

export function CorrectionDialog({
  open,
  onClose,
  onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  onSubmit: (data: {
    reason?: string;
    correctionContent: string;
    suggestedSource?: string;
    suggestedIngestion?: boolean;
  }) => void;
}) {
  const [correction, setCorrection] = useState("");
  const [source, setSource] = useState("");
  const [ingestion, setIngestion] = useState(false);

  function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (correction.trim() === "") {
      return;
    }
    const trimmedSource = source.trim();
    onSubmit({
      correctionContent: correction.trim(),
      ...(trimmedSource === "" ? {} : { suggestedSource: trimmedSource }),
      suggestedIngestion: ingestion,
    });
    setCorrection("");
    setSource("");
    setIngestion(false);
  }

  return (
    <Dialog open={open} onClose={onClose} title="纠错反馈" description="帮助我们改进答案质量。">
      <form onSubmit={submit} className="flex flex-col gap-4">
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium text-ink">正确答案是什么</span>
          <textarea
            value={correction}
            onChange={(e) => setCorrection(e.target.value)}
            rows={3}
            required
            placeholder="请填写你认为正确的答案"
            className="w-full resize-y rounded-md border border-border bg-neutral-0 px-3 py-2 text-base text-ink placeholder:text-ink-subtle focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium text-ink">相关资料在哪里(可选)</span>
          <input
            value={source}
            onChange={(e) => setSource(e.target.value)}
            placeholder="资料名称或位置"
            className="h-9.5 w-full rounded-md border border-border bg-neutral-0 px-3 text-base text-ink placeholder:text-ink-subtle focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
          />
        </label>
        <label className="flex items-center gap-2 text-base text-ink">
          <Checkbox
            checked={ingestion}
            onCheckedChange={(v) => setIngestion(v === true)}
            aria-label="建议补充到知识库"
          />
          建议补充到知识库
        </label>
        <div className="mt-1 flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            取消
          </Button>
          <Button type="submit" disabled={correction.trim() === ""}>
            提交纠错
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
