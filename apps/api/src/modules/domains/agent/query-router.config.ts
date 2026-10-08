// 意图识别先匹配完整的元问题和纯闲聊，未命中直接交给 LLM；不使用向量打分。
export const QUERY_ROUTER_VERSION = "rules-retrieval-decision-v5";
export const QUERY_ROUTES = [
  "social",
  "capability",
  "scope",
  "catalog",
  "redirect",
  "retrieve",
  "direct",
] as const;
export type QueryRoute = (typeof QUERY_ROUTES)[number];
export type IntentRule = {
  id: string;
  route: QueryRoute;
  pattern: RegExp;
};

// 正则必须整句匹配，防止“你好，报销怎么申请”被问候规则吞掉。
export const INTENT_RULES: IntentRule[] = [
  {
    id: "social-greeting",
    route: "social",
    pattern:
      /^(?:你好|您好|嗨|哈喽|早上好|早安|中午好|下午好|晚上好|晚安|hello|hi|hey)(?:呀|啊|哦|朋友)?$/iu,
  },
  {
    id: "social-thanks",
    route: "social",
    pattern:
      /^(?:谢谢|多谢|感谢|非常感谢)(?:你|您的回答|你的回答|啦|了)?(?:问题搞定啦|问题解决了)?$/u,
  },
  { id: "social-goodbye", route: "social", pattern: /^(?:再见|拜拜|回头见|bye|goodbye)$/iu },
  {
    id: "assistant-capability",
    route: "capability",
    pattern:
      /^(?:你能做什么|介绍一下你的功能|你是什么助手|该怎么使用这个知识库助手|你有什么功能|你可以做什么)$/u,
  },
  {
    id: "authorized-scope",
    route: "scope",
    pattern:
      /^(?:我(?:能|可以|有权限)(?:访问|使用|查询|询问)哪些知识库|(?:当前)?有哪些我有权限使用的知识库|(?:请)?列出我能查询的知识库|你能查哪些知识库|哪些知识库(?:已经|已)?向我的账号开放(?:了)?|我有哪些(?:可访问的|能查询的)知识库)$/u,
  },
  {
    id: "authorized-scope-english",
    route: "scope",
    pattern: /^(?:whichknowledgebasescaniaccess|whatknowledgebasesareavailabletome)$/iu,
  },
  {
    id: "catalog-all",
    route: "catalog",
    pattern:
      /^(?:请)?(?:列出|展示|查看)(?:当前|所有)?(?:可访问的|可查询的)?(?:知识库的)?(?:文档目录|资料目录|资料清单|文档标题|文件列表)$/u,
  },
  {
    id: "social-chat",
    route: "redirect",
    pattern: /^(?:陪我聊聊天|陪我聊天|聊聊天|给我讲个笑话|讲个笑话)$/u,
  },
];

// 只允许完整的指定库目录句式；库名需要在服务中再次映射到授权列表。
export const NAMED_CATALOG_PATTERN =
  /^(?:请)?(?:列出|展示|查看)(.{1,160}?(?:知识库|资料库|文档库|库))(?:的|中有哪些|里有哪些)(?:文档目录|资料清单|文档名称|文档标题|文件列表|文件)(?:不需要正文)?$/u;

// 仅统一空白与标点，不删除实际业务文字；无法完整匹配时保留给 LLM。
export function normalizeIntentText(query: string): string {
  return query.trim().replace(/[\s，。！？、,!?;；.：:]/gu, "");
}
