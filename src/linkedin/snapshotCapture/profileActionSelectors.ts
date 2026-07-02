import { ACTION_NAME_TOKENS, buildAriaLabelSelector, buildTokenAlternationSource } from "../logic/actionClassifier.js";

export const PROFILE_MORE_ARIA_SELECTOR = buildAriaLabelSelector(ACTION_NAME_TOKENS.more);
export const PROFILE_ACTION_TOKENS: readonly string[] = [
  ...ACTION_NAME_TOKENS.connect,
  ...ACTION_NAME_TOKENS.message,
  ...ACTION_NAME_TOKENS.more,
  ...ACTION_NAME_TOKENS.follow,
];
export const PROFILE_ACTION_ARIA_SELECTOR = buildAriaLabelSelector(PROFILE_ACTION_TOKENS);
export const PROFILE_ACTION_RE_SOURCE = buildTokenAlternationSource([...PROFILE_ACTION_TOKENS, "pending", "following"]);
export const PROFILE_BARE_ACTION_RE_SOURCE = buildTokenAlternationSource([
  "connect",
  "message",
  "more",
  "follow",
  "pending",
  "following",
  "连接",
  "添加好友",
  "写消息",
  "更多",
  "关注",
]);
export const PROFILE_MORE_RE_SOURCE = buildTokenAlternationSource(ACTION_NAME_TOKENS.more);
export const PROFILE_CONNECTISH_RE_SOURCE = buildTokenAlternationSource([
  ...ACTION_NAME_TOKENS.connect,
  "pending",
  "following",
]);
