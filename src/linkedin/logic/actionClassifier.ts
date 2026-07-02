export type LinkedInActionKind =
  | "connect_open"
  | "connect_send"
  | "connect_add_note"
  | "follow"
  | "message_open"
  | "message_send"
  | "composer_input"
  | "post_publish"
  | "start_post"
  | "more"
  | "none";

export const CONNECT_OPEN_RE = /^(?:connect$|invite\b.*\bto connect\b|邀请.*(?:加为好友|加入领英)$|添加好友$|连接$)/i;
export const CONNECT_SEND_RE =
  /^(?:send\s+invitation\b|send\s+invite\b|send\s+without\s+a\s+note\b|send\s+now\b|发送时不添加备注$|发送邀请$|直接发送$|立即连接$)/i;
export const CONNECT_ADD_NOTE_RE = /^(?:add a note$|添加备注$|添加消息$)/i;
export const FOLLOW_RE = /^(?:follow\b(?!ing)|关注(?!者))/i;
export const MESSAGE_OPEN_RE = /^(?:message\b|send a message to\b|给.*发消息$|写消息$)/i;
export const MESSAGE_SEND_RE =
  /^(?:send$|发送(?:\s*(?:消息|信息|私信))?|發送(?:\s*(?:消息|訊息|私訊))?|传送(?:\s*(?:消息|信息|私信))?|傳送(?:\s*(?:消息|訊息|私訊))?|送出)$/iu;
export const COMPOSER_INPUT_RE =
  /creating content|what do you want to talk about|text editor for creating content|内容创建文本编辑器/i;
export const POST_PUBLISH_RE = /^(?:post$|发布$|发帖$)/i;
// P-ZH-2 Step-6: 写文章 removed — it is LinkedIn's "Write article" feature, not Start-a-post,
// and collided with 发动态 (the real live-captured trigger) → start_post ambiguity.
export const START_POST_RE = /^(?:start a post$|发起帖子$|发动态$)/i;
export const MORE_RE = /^(?:more\b|…?\s*更多$)/i;
export const MESSAGING_INPUT_RE =
  /message|reply|write a message|enter message recipients|recipient|消息|回复|写消息|收件人/i;

export const ACTION_NAME_TOKENS = {
  connect: ["connect", "邀请", "加为好友", "连接", "添加好友"],
  more: ["more", "更多"],
  message: ["message", "发消息", "写消息"],
  follow: ["follow", "关注"],
  post: ["post", "发布", "发帖"],
  startPost: ["start a post", "发起帖子", "发动态", "写文章"],
} as const;

export function classifyActionName(name: string, opts?: { role?: string; structural?: unknown }): LinkedInActionKind {
  void opts;
  const trimmed = name.trim();
  if (!trimmed) return "none";
  if (CONNECT_ADD_NOTE_RE.test(trimmed)) return "connect_add_note";
  if (CONNECT_SEND_RE.test(trimmed)) return "connect_send";
  if (CONNECT_OPEN_RE.test(trimmed)) return "connect_open";
  if (FOLLOW_RE.test(trimmed)) return "follow";
  if (MESSAGE_OPEN_RE.test(trimmed)) return "message_open";
  if (COMPOSER_INPUT_RE.test(trimmed)) return "composer_input";
  if (POST_PUBLISH_RE.test(trimmed)) return "post_publish";
  if (START_POST_RE.test(trimmed)) return "start_post";
  if (MORE_RE.test(trimmed)) return "more";
  if (MESSAGE_SEND_RE.test(trimmed)) return "message_send";
  return "none";
}

export function personNameFromActionLabel(
  name: string,
): { kind: "follow" | "connect_open" | "message_open"; personName: string } | null {
  const trimmed = name.replace(/\s+/g, " ").trim();
  const inviteEn = trimmed.match(/^Invite\s+(.+?)\s+to connect\b/i);
  if (inviteEn?.[1]) return nameResult("connect_open", inviteEn[1]);

  const inviteZh = trimmed.match(/^邀请(.+?)(?:加为好友|加入领英)$/u);
  if (inviteZh?.[1]) return nameResult("connect_open", inviteZh[1]);

  const followEn = trimmed.match(/^Follow\s+(.+)$/i);
  if (followEn?.[1] && !/^following$/i.test(trimmed)) return nameResult("follow", followEn[1]);

  const followZh = trimmed.match(/^关注(?!者)(.+)$/u);
  if (followZh?.[1]) return nameResult("follow", followZh[1]);

  const messageEn = trimmed.match(/^Message\s+(.+)$/i) ?? trimmed.match(/^Send a message to\s+(.+)$/i);
  if (messageEn?.[1]) return nameResult("message_open", messageEn[1]);

  const messageZh = trimmed.match(/^给(.+?)发消息$/u);
  if (messageZh?.[1]) return nameResult("message_open", messageZh[1]);

  return null;
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function buildAriaLabelSelector(tokens: readonly string[]): string {
  return tokens.map((token) => `[aria-label*=${JSON.stringify(token)} i]`).join(",");
}

export function buildTokenAlternationSource(tokens: readonly string[]): string {
  return tokens.map(escapeRegExp).join("|");
}

function nameResult(
  kind: "follow" | "connect_open" | "message_open",
  value: string,
): { kind: "follow" | "connect_open" | "message_open"; personName: string } | null {
  const personName = value.replace(/\s+/g, " ").trim();
  return personName ? { kind, personName } : null;
}
