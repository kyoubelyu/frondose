export const MINIMAL_PUBLIC_SCOPE_IDS = [
  "page",
  "feed",
  "post",
  "comment",
  "reactionModal",
  "composerModal",
  "messagingThread",
  "messagingSearch",
  "messagingConversationList",
  "messagingConversation",
  "networkView",
  "notificationsView",
  "searchResults",
  "profileView",
  "companyView",
  "companyInboxThread",
  "composerInput",
  "threadInput",
  "postActions",
] as const;

export type MinimalPublicScopeId = (typeof MINIMAL_PUBLIC_SCOPE_IDS)[number];

export const MINIMAL_PUBLIC_SCOPE_SET = new Set<MinimalPublicScopeId>(MINIMAL_PUBLIC_SCOPE_IDS);

export function isMinimalPublicScopeId(value: string): value is MinimalPublicScopeId {
  return MINIMAL_PUBLIC_SCOPE_SET.has(value as MinimalPublicScopeId);
}

export const MINIMAL_PUBLIC_SCOPE_PARENTS: Partial<Record<MinimalPublicScopeId, MinimalPublicScopeId>> = {
  feed: "page",
  post: "feed",
  comment: "post",
  reactionModal: "page",
  postActions: "post",
  composerModal: "feed",
  composerInput: "composerModal",
  messagingThread: "page",
  messagingSearch: "messagingThread",
  messagingConversationList: "messagingThread",
  messagingConversation: "messagingThread",
  threadInput: "messagingConversation",
  networkView: "page",
  notificationsView: "page",
  searchResults: "page",
  profileView: "page",
  companyView: "page",
  companyInboxThread: "companyView",
};

export const MINIMAL_PUBLIC_SCOPE_LABELS: Record<MinimalPublicScopeId, string> = {
  page: "Page",
  feed: "Feed",
  post: "Post",
  comment: "Comment",
  reactionModal: "Reaction modal",
  composerModal: "Composer modal",
  messagingThread: "Messaging view",
  messagingSearch: "Message search",
  messagingConversationList: "Conversation list",
  messagingConversation: "Active conversation",
  networkView: "Network view",
  notificationsView: "Notifications view",
  searchResults: "Search results",
  profileView: "Profile view",
  companyView: "Company view",
  companyInboxThread: "Company inbox thread",
  composerInput: "Composer input",
  threadInput: "Thread composer",
  postActions: "Post actions",
};
