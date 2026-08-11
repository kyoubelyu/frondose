// P0-3 — UI i18n (zh-CN). Tiny typed string-table + t() lookup; NO third-party i18n library.
// Locale is detected ONCE from navigator.language (zh* → zh-CN, else en); en is the fallback.
// index.html ships the en strings statically; localizeDocument() re-writes the static DOM at boot
// via data-i18n / data-i18n-placeholder / data-i18n-title / data-i18n-aria attributes.
//
// DOM-lib-free (mirrors render.ts): compiled by BOTH the Tauri-UI build (lib DOM) and the main
// build (no DOM lib) — and bundled into the overlay's __frondoseShared IIFE via mode.ts/render
// leaves — so this module references ONLY the structural `*Like` interfaces below and reaches
// navigator through a typed cast on globalThis.

export type Locale = "en" | "zh-CN";

const en = {
  // topbar / mode
  "tab.manual": "Manual",
  "tab.auto": "Auto",
  "aria.mode": "Mode",
  "badge.manual": "MANUAL",
  "badge.magical": "MAGICAL",
  "badge.auto": "AUTO",
  "status.listening": "Listening",
  "status.observing": "Observing",
  "status.working": "Working",
  "status.thinking": "thinking…",
  // composer
  "composer.placeholder.manual": "Reply, or press / for actions",
  "composer.placeholder.auto": "Inject a rule, ask a question, or interrupt…",
  "composer.send": "Send",
  "composer.steer": "Steer",
  "composer.cancel": "Cancel",
  "composer.terminate": "Terminate",
  // ticker
  "ticker.starting": "starting...",
  "ticker.cronRunning": "cron running...",
  "ticker.retrying": "retrying last prompt...",
  "ticker.done": "done ({reason})",
  "ticker.cronActive": "cron active",
  "reason.aborted": "aborted",
  // transient status-line messages
  "status.overlayReconnected": "overlay reconnected",
  "status.suggestionCard": "suggestion card rendered in-page",
  "status.nextActions": "next actions rendered in-page",
  "status.profile": "profile: {handle}",
  // errors / banners
  "error.generic": "error",
  "error.actionFailed": "{label} failed: {msg}",
  "error.boot": "boot error: {msg}",
  "error.turnRejected": "turn rejected: {reason}",
  "error.invokeFailed": "invoke failed: {msg}",
  "error.steerTimeout": "steer timeout - aborted turn never confirmed",
  "error.steerRejected": "steer resubmit rejected: {reason}",
  "error.steerFailed": "steer failed: {msg}",
  "error.retryRejected": "retry rejected: {reason}",
  "error.retryInvokeFailed": "retry invoke failed: {msg}",
  "error.agent": "agent error: {msg}",
  "error.noTauri": "__TAURI__ missing - not running inside Tauri shell",
  "error.unknown": "unknown",
  "error.autoStartEmpty": "Type a standing prompt in the composer before switching to Auto.",
  "retry.button": "Retry",
  // surfaceError action labels
  "action.setModeCron": "Set mode (cron)",
  "action.setModePassive": "Set mode (passive)",
  "action.approve": "Approve",
  "action.decline": "Decline",
  "action.handoff": "Hand off to Auto",
  "action.pauseAbort": "Pause/abort",
  "action.turn": "Run turn",
  "action.openSettings": "Open settings",
  "action.saveSettings": "Save settings",
  "action.checkUpdate": "Check for updates",
  "update.completed": "Frondose updated to {version}.",
  // identity gate
  "identity.loading": "loading identity...",
  "identity.hint": "New here — just say hello and Frondose will introduce itself.",
  "identity.noFullName": "(no fullName in identity)",
  // workflow card (Manual)
  "workflow.defaultTitle": "workflow",
  "workflow.pause": "Pause",
  "workflow.showAll": "Show all steps",
  "workflow.showFewer": "Show fewer steps",
  "workflow.approvalRequired": "Approval required before outbound action.",
  "workflow.approvedResuming": "Approved. Resuming workflow.",
  "workflow.declined": "Declined.",
  "workflow.autoEnabled": "Auto mode enabled.",
  "workflow.advisoryNotice": "Advisory: possible outbound click ({label}).",
  "workflow.advisoryStatus": "Advisory: possible outbound click ({label})",
  "workflow.stepOne": "{n} step",
  "workflow.stepOther": "{n} steps",
  "workflow.confirmOne": "{n} confirmation required",
  "workflow.confirmOther": "{n} confirmations required",
  "workflow.moreSteps": " · +{n} more steps",
  // step chips / right labels
  "chip.needsYou": "needs you",
  "chip.working": "working",
  "chip.running": "running",
  "chip.autoApproved": "auto-approved",
  "chip.done": "done",
  "chip.failed": "failed",
  // auto stage
  "auto.ready": "Auto is ready",
  "auto.waitingNextRun": "Waiting for the next scheduled run",
  "auto.runningInChrome": "Running in Chrome",
  "auto.pause": "Pause",
  "auto.takeOver": "Take over",
  "auto.now": "Now",
  "auto.idle": "Idle",
  "auto.preparing": "Preparing",
  "auto.timelineEmpty": "Steps will appear here as the workflow runs.",
  // dock (Auto footer)
  "dock.conversation": "Conversation",
  "dock.keepPosted": "I'll keep you posted here. Inject a rule or ask a question anytime.",
  // settings panel
  "settings.title": "Settings",
  "settings.back": "Back",
  "settings.groupLanguage": "Language",
  "settings.langAuto": "Auto (system)",
  "settings.langEn": "English",
  "settings.langZh": "中文",
  "settings.groupModel": "Model (custom URL)",
  "settings.baseUrl": "Base URL",
  "settings.baseUrlPlaceholder": "https://your-provider.example/v1",
  "settings.model": "Model",
  "settings.modelPlaceholder": "deepseek:deepseek-v4-flash",
  "settings.apiKey": "API key",
  "settings.hint.baseUrl": "Intranet inference server URL (ask your admin), e.g. https://.../v1",
  "settings.hint.model": "Format: provider:model — e.g. deepseek:deepseek-v4-flash",
  "settings.hint.apiKey": "Your personal API key (ask your admin).",
  "settings.hint.fillAll": "All three fields are required — see the Frondose install & first-use guide (intranet / Windows).",
  "settings.groupIdentity": "Identity",
  "settings.name": "Name",
  "settings.company": "Company",
  "settings.role": "Role",
  "settings.headline": "Headline",
  "settings.profileUrl": "LinkedIn profile URL",
  "settings.persona": "Persona",
  "settings.style": "Communication style",
  "settings.contact": "Contact",
  "settings.icpRoles": "ICP target roles",
  "settings.icpPlaceholder": "VP Sales, Head of Growth",
  "settings.icpIndustry": "ICP industry",
  "settings.icpIndustryPlaceholder": "SaaS, Fintech",
  "settings.icpRegion": "ICP region",
  "settings.icpRegionPlaceholder": "US, EMEA",
  "settings.icpKeywords": "ICP company keywords",
  "settings.icpKeywordsPlaceholder": "fintech, payments",
  "settings.groupAxes": "Methodology habits (advanced)",
  "settings.axisPainChain": "Pain Chain direction",
  "settings.axisLeadRole": "Key Players entry point",
  "settings.axisDiscovery": "Discovery pacing",
  "settings.axisStory": "Spark-interest story shape",
  "settings.axisPainChain.causeFirst": "cause-first",
  "settings.axisPainChain.economicBuyerFirst": "economic-buyer-first",
  "settings.axisPainChain.speculativeChainBuilt": "speculative-chain-built",
  "settings.axisPainChain.admittedPainStart": "admitted-pain-start",
  "settings.axisPainChain.lateralStakeholderFirst": "lateral-stakeholder-first",
  "settings.axisPainChain.causeConfirmedThenUp": "cause-confirmed-then-up",
  "settings.axisLeadRole.painOwnerFirst": "pain-owner first",
  "settings.axisLeadRole.economicBuyerFirst": "economic-buyer first",
  "settings.axisLeadRole.technicalEvaluatorFirst": "technical-evaluator first",
  "settings.axisLeadRole.practitionerFirst": "practitioner first",
  "settings.axisLeadRole.championLed": "champion-led",
  "settings.axisLeadRole.multiThreadParallel": "multi-thread-parallel",
  "settings.axisDiscovery.rLean": "R-lean",
  "settings.axisDiscovery.iLean": "I-lean",
  "settings.axisDiscovery.cLean": "C-lean",
  "settings.axisDiscovery.ratioDisciplined": "ratio-disciplined",
  "settings.axisDiscovery.precallThorough": "precall-thorough",
  "settings.axisDiscovery.validateCloseFast": "validate-close-fast",
  "settings.axisDiscovery.sparkInterestFocused": "spark-interest-focused",
  "settings.axisStory.referenceStoryLed": "reference-story led",
  "settings.axisStory.initialValuePropLed": "initial-value-prop led",
  "settings.axisStory.causeNamedDirect": "cause-named direct",
  "settings.axisStory.painQuestionFirst": "pain-question first",
  "settings.axisStory.numberAnchoredOpener": "number-anchored opener",
  "settings.axisStory.c3ShapedCloser": "C3-shaped closer",
  "settings.groupSoul": "Soul override (advanced)",
  "settings.soulPlaceholder": "Leave blank to use the default soul band.",
  "settings.groupUpdates": "Updates",
  "settings.updateUrl": "Update server URL",
  "settings.updateUrlPlaceholder": "http://192.168.x.x:8765 or http://host.local:8765",
  "settings.save": "Save",
  "settings.saved": "✓ Saved", // ISSUE-SAVE-MODAL: transient save-success toast text
  "settings.noKeySet": "no key set",
  "settings.checking": "Checking…",
  "settings.updating": "Updating…",
  "settings.upToDate": "Up to date",
  // P-FIX-MAC-UPDATER-RELAUNCH: update-status event stages (settings status line)
  "settings.downloading": "Downloading update {version}…",
  "settings.installing": "Installing update…",
  "settings.relaunching": "Update installed — relaunching…",
  "settings.updateError": "Update failed: {msg}",
} as const;

export type I18nKey = keyof typeof en;

const zhCN: Record<I18nKey, string> = {
  // topbar / mode
  "tab.manual": "手动",
  "tab.auto": "自动",
  "aria.mode": "模式",
  "badge.manual": "手动",
  "badge.magical": "魔法",
  "badge.auto": "自动",
  "status.listening": "待命",
  "status.observing": "观察中",
  "status.working": "工作中",
  "status.thinking": "思考中…",
  // composer
  "composer.placeholder.manual": "回复，或按 / 选择操作",
  "composer.placeholder.auto": "输入规则、提问，或打断当前任务…",
  "composer.send": "发送",
  "composer.steer": "转向",
  "composer.cancel": "取消",
  "composer.terminate": "终止",
  // ticker
  "ticker.starting": "正在启动…",
  "ticker.cronRunning": "定时任务运行中…",
  "ticker.retrying": "正在重试上一条指令…",
  "ticker.done": "已完成（{reason}）",
  "ticker.cronActive": "定时任务进行中",
  "reason.aborted": "已中止",
  // transient status-line messages
  "status.overlayReconnected": "悬浮层已重连",
  "status.suggestionCard": "建议卡片已在页面中显示",
  "status.nextActions": "后续操作已在页面中显示",
  "status.profile": "主页：{handle}",
  // errors / banners
  "error.generic": "错误",
  "error.actionFailed": "{label}失败：{msg}",
  "error.boot": "启动错误：{msg}",
  "error.turnRejected": "任务被拒绝：{reason}",
  "error.invokeFailed": "调用失败：{msg}",
  "error.steerTimeout": "转向超时——上一轮任务未确认结束",
  "error.steerRejected": "转向请求被拒绝：{reason}",
  "error.steerFailed": "转向失败：{msg}",
  "error.retryRejected": "重试被拒绝：{reason}",
  "error.retryInvokeFailed": "重试调用失败：{msg}",
  "error.agent": "智能体出错：{msg}",
  "error.noTauri": "未检测到 __TAURI__——应用未在 Tauri 壳内运行",
  "error.unknown": "未知错误",
  "error.autoStartEmpty": "请先在输入框中写下自动模式的常驻指令，再切换到自动。",
  "retry.button": "重试",
  // surfaceError action labels
  "action.setModeCron": "设置模式（定时）",
  "action.setModePassive": "设置模式（被动）",
  "action.approve": "批准",
  "action.decline": "拒绝",
  "action.handoff": "交给自动模式",
  "action.pauseAbort": "暂停/中止",
  "action.turn": "执行任务",
  "action.openSettings": "打开设置",
  "action.saveSettings": "保存设置",
  "action.checkUpdate": "检查更新",
  "update.completed": "Frondose 已更新至 {version}。",
  // identity gate
  "identity.loading": "正在加载身份…",
  "identity.hint": "初次见面 — 打个招呼，Frondose 会主动介绍自己。",
  "identity.noFullName": "（身份信息缺少姓名）",
  // workflow card (Manual)
  "workflow.defaultTitle": "工作流",
  "workflow.pause": "暂停",
  "workflow.showAll": "显示全部步骤",
  "workflow.showFewer": "收起步骤",
  "workflow.approvalRequired": "外发操作前需要你的批准。",
  "workflow.approvedResuming": "已批准，继续执行工作流。",
  "workflow.declined": "已拒绝。",
  "workflow.autoEnabled": "已启用自动模式。",
  "workflow.advisoryNotice": "提示：可能发生外发点击（{label}）。",
  "workflow.advisoryStatus": "提示：可能发生外发点击（{label}）",
  "workflow.stepOne": "{n} 个步骤",
  "workflow.stepOther": "{n} 个步骤",
  "workflow.confirmOne": "{n} 项需确认",
  "workflow.confirmOther": "{n} 项需确认",
  "workflow.moreSteps": " · 还有 {n} 步",
  // step chips / right labels
  "chip.needsYou": "需要你",
  "chip.working": "进行中",
  "chip.running": "运行中",
  "chip.autoApproved": "自动批准",
  "chip.done": "已完成",
  "chip.failed": "失败",
  // auto stage
  "auto.ready": "自动模式已就绪",
  "auto.waitingNextRun": "等待下一次定时运行",
  "auto.runningInChrome": "正在 Chrome 中运行",
  "auto.pause": "暂停",
  "auto.takeOver": "接管",
  "auto.now": "当前",
  "auto.idle": "空闲",
  "auto.preparing": "准备中",
  "auto.timelineEmpty": "工作流运行时，步骤会显示在这里。",
  // dock (Auto footer)
  "dock.conversation": "对话",
  "dock.keepPosted": "我会在这里向你汇报进展，你可以随时输入规则或提问。",
  // settings panel
  "settings.title": "设置",
  "settings.back": "返回",
  "settings.groupLanguage": "语言",
  "settings.langAuto": "自动（跟随系统）",
  "settings.langEn": "English",
  "settings.langZh": "中文",
  "settings.groupModel": "模型（自定义 URL）",
  "settings.baseUrl": "服务地址（Base URL）",
  "settings.baseUrlPlaceholder": "https://your-provider.example/v1",
  "settings.model": "模型",
  "settings.modelPlaceholder": "deepseek:deepseek-v4-flash",
  "settings.apiKey": "API key",
  "settings.hint.baseUrl": "内网推理服务地址（向管理员获取），示例：https://.../v1",
  "settings.hint.model": "格式：提供商:模型名；示例：deepseek:deepseek-v4-flash",
  "settings.hint.apiKey": "你个人的 API key（向管理员获取）。",
  "settings.hint.fillAll": "三项都填好才能使用；详见《Frondose 安装与首次使用指南(内网 / Windows)》。",
  "settings.groupIdentity": "身份",
  "settings.name": "姓名",
  "settings.company": "公司",
  "settings.role": "职位",
  "settings.headline": "头衔",
  "settings.profileUrl": "LinkedIn 个人主页链接",
  "settings.persona": "人设",
  "settings.style": "沟通风格",
  "settings.contact": "联系方式",
  "settings.icpRoles": "目标客户职位（ICP）",
  "settings.icpPlaceholder": "销售副总裁、增长负责人",
  "settings.icpIndustry": "目标客户行业（ICP）",
  "settings.icpIndustryPlaceholder": "SaaS、金融科技",
  "settings.icpRegion": "目标客户地区（ICP）",
  "settings.icpRegionPlaceholder": "美国、EMEA",
  "settings.icpKeywords": "目标客户公司关键词",
  "settings.icpKeywordsPlaceholder": "金融科技、支付",
  "settings.groupAxes": "方法论习惯（高级）",
  "settings.axisPainChain": "Pain Chain 方向",
  "settings.axisLeadRole": "Key Players 切入角色",
  "settings.axisDiscovery": "9-block 节奏",
  "settings.axisStory": "首次触达故事形态",
  "settings.axisPainChain.causeFirst": "从原因切入",
  "settings.axisPainChain.economicBuyerFirst": "先找经济决策者",
  "settings.axisPainChain.speculativeChainBuilt": "先构建假设痛点链",
  "settings.axisPainChain.admittedPainStart": "从已承认的痛点开始",
  "settings.axisPainChain.lateralStakeholderFirst": "先找同级利益相关者",
  "settings.axisPainChain.causeConfirmedThenUp": "确认原因后向上推进",
  "settings.axisLeadRole.painOwnerFirst": "痛点负责人优先",
  "settings.axisLeadRole.economicBuyerFirst": "经济决策者优先",
  "settings.axisLeadRole.technicalEvaluatorFirst": "技术评估者优先",
  "settings.axisLeadRole.practitionerFirst": "一线使用者优先",
  "settings.axisLeadRole.championLed": "由内部支持者带动",
  "settings.axisLeadRole.multiThreadParallel": "多线并行",
  "settings.axisDiscovery.rLean": "偏重回应",
  "settings.axisDiscovery.iLean": "偏重探索",
  "settings.axisDiscovery.cLean": "偏重确认",
  "settings.axisDiscovery.ratioDisciplined": "严格遵循比例",
  "settings.axisDiscovery.precallThorough": "通话前充分准备",
  "settings.axisDiscovery.validateCloseFast": "快速验证并收口",
  "settings.axisDiscovery.sparkInterestFocused": "聚焦激发兴趣",
  "settings.axisStory.referenceStoryLed": "以参考故事开场",
  "settings.axisStory.initialValuePropLed": "以初始价值主张开场",
  "settings.axisStory.causeNamedDirect": "直接点明原因",
  "settings.axisStory.painQuestionFirst": "先问痛点",
  "settings.axisStory.numberAnchoredOpener": "以数字锚点开场",
  "settings.axisStory.c3ShapedCloser": "C3 式收尾",
  "settings.groupSoul": "灵魂设定覆盖（高级）",
  "settings.soulPlaceholder": "留空则使用默认灵魂设定。",
  "settings.groupUpdates": "更新",
  "settings.updateUrl": "更新服务器地址",
  "settings.updateUrlPlaceholder": "http://192.168.x.x:8765 或 http://host.local:8765",
  "settings.save": "保存",
  "settings.saved": "✓ 已保存", // ISSUE-SAVE-MODAL: transient save-success toast text
  "settings.noKeySet": "未设置 key",
  "settings.checking": "检查中…",
  "settings.updating": "更新中…",
  "settings.upToDate": "已是最新版本",
  // P-FIX-MAC-UPDATER-RELAUNCH: update-status event stages (settings status line)
  "settings.downloading": "正在下载更新 {version}…",
  "settings.installing": "正在安装更新…",
  "settings.relaunching": "更新完成——即将重启…",
  "settings.updateError": "更新失败：{msg}",
};

/** zh* (zh, zh-CN, zh-TW, zh-Hans-CN…) → zh-CN; everything else → en. */
export function detectLocale(lang?: string): Locale {
  const raw = lang ?? (globalThis as { navigator?: { language?: string } }).navigator?.language ?? "";
  return /^zh/i.test(raw) ? "zh-CN" : "en";
}

/** P-ZH-1: map the operator's Settings language pref to a UI Locale — "auto" defers to detectLocale(). */
export function prefToLocale(pref: "auto" | "en" | "zh"): Locale {
  if (pref === "zh") return "zh-CN";
  if (pref === "en") return "en";
  return detectLocale();
}

let locale: Locale = detectLocale();

export function getLocale(): Locale {
  return locale;
}

/** Test/override hook — production never calls this (locale is detected once at load). */
export function setLocale(next: Locale): void {
  locale = next;
}

/** Lookup with en fallback + simple {name} interpolation. */
export function t(key: I18nKey, params?: Record<string, string | number>): string {
  const table: Record<I18nKey, string> = locale === "zh-CN" ? zhCN : en;
  const raw = table[key];
  let s: string = raw.length > 0 ? raw : en[key];
  if (params) {
    for (const [name, value] of Object.entries(params)) s = s.split(`{${name}}`).join(String(value));
  }
  return s;
}

export function formatActionFailure(label: string, error: unknown): string {
  const msg = error instanceof Error ? error.message : String(error);
  return t("error.actionFailed", { label, msg });
}

export function isI18nKey(key: string): key is I18nKey {
  return Object.prototype.hasOwnProperty.call(en, key);
}

// --- static-DOM localization (index.html ships en; boot re-writes for zh-CN) ---

interface I18nTargetLike {
  textContent: string | null;
  getAttribute?(name: string): string | null;
  setAttribute?(name: string, value: string): void;
}
export interface LocalizableDocumentLike {
  querySelectorAll?(selector: string): ArrayLike<I18nTargetLike>;
  documentElement?: { setAttribute?(name: string, value: string): void };
}

const DATA_ATTRS = [
  { attr: "data-i18n", target: null },
  { attr: "data-i18n-placeholder", target: "placeholder" },
  { attr: "data-i18n-title", target: "title" },
  { attr: "data-i18n-aria", target: "aria-label" },
] as const;

/** No-op under en (the static HTML already IS the en table) UNLESS `force` is set. P-ZH-1:
 * a live language-pref switch back to "en" (after having switched to zh-CN) needs the DOM
 * written BACK to en — pass `force: true` for that call; the original boot-time call site
 * (always en-or-fresh) keeps relying on the no-op default. */
export function localizeDocument(doc: LocalizableDocumentLike, opts?: { force?: boolean }): void {
  if (locale === "en" && !opts?.force) return;
  for (const { attr, target } of DATA_ATTRS) {
    const nodes = doc.querySelectorAll?.(`[${attr}]`) ?? [];
    for (let i = 0; i < nodes.length; i++) {
      const el = nodes[i];
      if (!el) continue;
      const key = el.getAttribute?.(attr);
      if (!key || !isI18nKey(key)) continue;
      if (target === null) el.textContent = t(key);
      else el.setAttribute?.(target, t(key));
    }
  }
  doc.documentElement?.setAttribute?.("lang", locale);
}
