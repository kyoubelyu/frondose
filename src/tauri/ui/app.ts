// P-56a M-1 scaffold + P-56b M-1 overlay wiring.
// Plain HTML + tsc-compiled TS, no React/Vite. Invokes Rust through window.__TAURI__.

export {};

type InvokeFn = <T = unknown>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
type Unlisten = () => void;
type ListenFn = <T>(event: string, handler: (e: { payload: T }) => void) => Promise<Unlisten>;

declare global {
  interface Window {
    __TAURI__?: {
      core: { invoke: InvokeFn };
      event: { listen: ListenFn };
    };
  }
}

type IdentityOk = { ok: true; fullName?: string; role?: string; company?: string; headline?: string };
type IdentityErr = { ok: false; reason: string };
type IdentityResp = IdentityOk | IdentityErr;
type ChromeOk = { ok: true; chromePort: number; overlayInstalled: boolean };
type ChromeErr = { ok: false; error: string; message?: string };
type ChromeResp = ChromeOk | ChromeErr;
type TurnOk = { ok: true; turnId: string };
type TurnErr = { ok: false; reason: string; turnId?: string; attempts?: number };
type TurnResp = TurnOk | TurnErr;

type SseFrame =
  | { type: "tool-call"; turnId: string; toolName: string }
  | { type: "text"; turnId: string; chunk: string }
  | { type: "step-done"; turnId: string; toolNames: string[] }
  | { type: "done"; turnId: string; finishReason: string; aborted?: boolean }
  | { type: "error"; turnId?: string; message: string; retryable?: boolean }
  | { type: "overlay-reconnected" }
  | { type: "overlay-event"; event: unknown }
  | { type: "suggestion-card"; turnId?: string }
  | { type: "next-actions"; turnId?: string }
  | { type: "profile-nav"; profileHandle?: string }
  | { type: "dialog-mode"; dialogMode?: "expand" | "collapse" }
  | { type: "cron-mode"; cronEnabled?: boolean }
  | { type: "passive-mode"; passiveEnabled?: boolean }
  | { type: "cron-tick"; cronRunId: string; taskHint?: string; ts: number }
  | { type: "cron-done"; cronRunId: string; ts: number };

interface ClassListLike {
  add(token: string): void;
  remove(token: string): void;
  toggle(token: string, force?: boolean): void;
}

interface TextElementLike {
  classList: ClassListLike;
  textContent: string | null;
}

interface ButtonElementLike extends TextElementLike {
  disabled: boolean;
  addEventListener(type: "click", listener: () => void): void;
}

interface InputElementLike extends TextElementLike {
  value: string;
  disabled: boolean;
  addEventListener(type: "keydown", listener: (e: { key?: string; preventDefault: () => void }) => void): void;
  addEventListener(type: "input", listener: () => void): void;
}

interface DocumentLike {
  getElementById(id: string): TextElementLike | null;
}

const windowRef = globalThis as unknown as Window & { document: DocumentLike };

function mustGet<T extends TextElementLike>(id: string): T {
  const el = windowRef.document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as unknown as T;
}

type AppState = "identity-missing" | "chrome-needed" | "idle" | "running" | "error";
let appState: AppState = "chrome-needed";
let currentTurnId: string | null = null;
let steerInFlight = false;
let lastTurnPrompt: string | null = null;

const nameEl = mustGet<TextElementLike>("name");
const startEl = mustGet<ButtonElementLike>("start");
const statusEl = mustGet<TextElementLike>("status");
const commandEl = mustGet<InputElementLike>("command-input");
const sendEl = mustGet<ButtonElementLike>("send-btn");
const autoModeBtnEl = mustGet<ButtonElementLike>("auto-mode-toggle");
const passiveModeBtnEl = mustGet<ButtonElementLike>("passive-mode-toggle");
const tickerEl = mustGet<TextElementLike>("ticker");
const outputEl = mustGet<TextElementLike>("output");
const errorBannerEl = mustGet<TextElementLike>("error-banner");
const retryBtnEl = mustGet<ButtonElementLike>("retry-btn");
const cronTickBannerEl = mustGet<TextElementLike>("cron-tick-banner");
let cronEnabled = true;
let passiveEnabled = false; // P-57g — passive auto-react default OFF

function invoke<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!windowRef.__TAURI__) throw new Error("__TAURI__ missing - not running inside Tauri shell");
  return windowRef.__TAURI__.core.invoke<T>(cmd, args);
}

function transition(next: AppState): void {
  appState = next;
  startEl.classList.toggle("hidden", next !== "chrome-needed");
  commandEl.classList.toggle("hidden", next !== "idle" && next !== "running");
  sendEl.classList.toggle("hidden", next !== "idle" && next !== "running");
  tickerEl.classList.toggle("hidden", next !== "running");
  outputEl.classList.toggle("hidden", next === "identity-missing" || next === "chrome-needed");
  errorBannerEl.classList.toggle("hidden", next !== "error");
  commandEl.disabled = next !== "idle" && next !== "running";
  sendEl.disabled = next !== "idle" && next !== "running";
  if (next === "idle") {
    sendEl.textContent = "Send";
    commandEl.value = "";
    retryBtnEl.classList.add("hidden");
  } else if (next === "running") {
    updateSendButtonLabel();
  }
}

function updateSendButtonLabel(): void {
  if (appState !== "running") return;
  sendEl.textContent = commandEl.value.trim().length > 0 ? "Steer" : "Cancel";
}

async function loadIdentity(): Promise<void> {
  try {
    const r = await invoke<IdentityResp>("mai_identity");
    if (r.ok === false) {
      nameEl.classList.add("error");
      nameEl.textContent = r.reason;
      transition("identity-missing");
      return;
    }
    nameEl.classList.remove("error");
    nameEl.textContent = r.fullName ?? "(no fullName in identity)";
    transition("chrome-needed");
  } catch (e) {
    nameEl.classList.add("error");
    nameEl.textContent = String(e);
    errorBannerEl.textContent = `boot error: ${String(e)}`;
    transition("error");
  }
}

async function startLinkedIn(): Promise<void> {
  startEl.disabled = true;
  startEl.textContent = "Starting...";
  statusEl.textContent = "";
  try {
    const r = await invoke<ChromeResp>("mai_chrome_ensure");
    if (r.ok === false) {
      statusEl.textContent = `error: ${r.message ?? r.error}`;
      startEl.disabled = false;
      startEl.textContent = "Start LinkedIn";
      return;
    }
    statusEl.textContent = `Chrome on port ${r.chromePort}`;
    transition("idle");
  } catch (e) {
    statusEl.textContent = String(e);
    startEl.disabled = false;
    startEl.textContent = "Start LinkedIn";
  }
}

async function toggleAutoMode(): Promise<void> {
  const next = !cronEnabled;
  try {
    const r = await invoke<{ ok: boolean; cronEnabled?: boolean }>("mai_set_cron_mode", { enabled: next });
    if (r.ok) {
      cronEnabled = r.cronEnabled ?? next;
      autoModeBtnEl.textContent = `Auto-mode: ${cronEnabled ? "ON" : "OFF"}`;
    }
  } catch {
    // The next SSE cron-mode event owns eventual resync.
  }
}

async function togglePassiveMode(): Promise<void> {
  const next = !passiveEnabled;
  try {
    const r = await invoke<{ ok: boolean; passiveEnabled?: boolean }>("mai_set_passive_mode", { enabled: next });
    if (r.ok) {
      passiveEnabled = r.passiveEnabled ?? next;
      passiveModeBtnEl.textContent = `Magical click: ${passiveEnabled ? "ON" : "OFF"}`;
    }
  } catch {
    // The next SSE passive-mode event owns eventual resync.
  }
}

async function sendCommand(): Promise<void> {
  if (appState === "running" && currentTurnId !== null) {
    const text = commandEl.value.trim();
    if (text.length > 0) {
      void performSteer(text);
      return;
    }
    try {
      await invoke("mai_agent_abort");
    } catch {
      // Best-effort; the SSE error/done event owns UI recovery.
    }
    return;
  }

  if (appState !== "idle") return;
  const prompt = commandEl.value.trim();
  if (!prompt) return;
  retryBtnEl.classList.add("hidden");
  errorBannerEl.classList.add("hidden");
  try {
    const r = await invoke<TurnResp>("mai_agent_turn", { prompt });
    if (r.ok === false) {
      errorBannerEl.textContent = `turn rejected: ${r.reason}`;
      transition("error");
      return;
    }
    currentTurnId = r.turnId;
    lastTurnPrompt = prompt;
    outputEl.textContent = "";
    tickerEl.textContent = "starting...";
    transition("running");
  } catch (e) {
    errorBannerEl.textContent = `invoke failed: ${String(e)}`;
    transition("error");
  }
}

async function waitForDoneSse(targetTurnId: string, timeoutMs = 3000, intervalMs = 50): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (currentTurnId === null || currentTurnId !== targetTurnId) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}

async function performSteer(newPrompt: string): Promise<void> {
  if (steerInFlight) return;
  if (appState !== "running" || currentTurnId === null) return;
  steerInFlight = true;
  const previousTurnId = currentTurnId;
  try {
    try {
      await invoke("mai_agent_abort");
    } catch {
      // The follow-up turn response owns the visible error if abort fails.
    }
    const completed = await waitForDoneSse(previousTurnId, 3000, 50);
    if (!completed) {
      errorBannerEl.textContent = "steer timeout - aborted turn never confirmed";
      transition("error");
      return;
    }
    const r = await invoke<TurnResp>("mai_agent_turn", { prompt: newPrompt });
    if (r.ok === false) {
      errorBannerEl.textContent = `steer resubmit rejected: ${r.reason}`;
      transition("error");
      return;
    }
    currentTurnId = r.turnId;
    lastTurnPrompt = newPrompt;
    outputEl.textContent = "";
    tickerEl.textContent = "starting...";
    transition("running");
  } catch (e) {
    errorBannerEl.textContent = `steer failed: ${String(e)}`;
    transition("error");
  } finally {
    steerInFlight = false;
  }
}

async function performRetry(): Promise<void> {
  retryBtnEl.classList.add("hidden");
  errorBannerEl.classList.add("hidden");
  try {
    const r = await invoke<TurnResp>("mai_agent_retry");
    if (r.ok === false) {
      errorBannerEl.textContent = `retry rejected: ${r.reason}`;
      errorBannerEl.classList.remove("hidden");
      transition("error");
      return;
    }
    currentTurnId = r.turnId;
    outputEl.textContent = "";
    tickerEl.textContent = lastTurnPrompt === null ? "starting..." : "retrying last prompt...";
    transition("running");
  } catch (e) {
    errorBannerEl.textContent = `retry invoke failed: ${String(e)}`;
    errorBannerEl.classList.remove("hidden");
    transition("error");
  }
}

function handleEvent(payload: SseFrame): void {
  switch (payload.type) {
    case "tool-call":
      if (payload.turnId === currentTurnId) {
        tickerEl.textContent = `${payload.toolName}...`;
      }
      break;
    case "text":
      if (payload.turnId === currentTurnId) {
        const prev = outputEl.textContent ?? "";
        outputEl.textContent = prev + payload.chunk;
      }
      break;
    case "step-done":
      break;
    case "done":
      if (payload.turnId === currentTurnId) {
        tickerEl.textContent = `done (${payload.finishReason})`;
        currentTurnId = null;
        if (payload.aborted !== true) {
          retryBtnEl.classList.add("hidden");
          errorBannerEl.classList.add("hidden");
          lastTurnPrompt = null;
        }
        transition("idle");
      }
      break;
    case "error":
      errorBannerEl.textContent = `agent error: ${payload.message}`;
      currentTurnId = null;
      transition("error");
      if (payload.retryable === true) {
        retryBtnEl.classList.remove("hidden");
      } else {
        retryBtnEl.classList.add("hidden");
      }
      break;
    case "overlay-reconnected":
      statusEl.textContent = "overlay reconnected";
      setTimeout(() => {
        statusEl.textContent = "Chrome on port 9222";
      }, 2000);
      break;
    case "overlay-event":
      break;
    case "suggestion-card":
      statusEl.textContent = "suggestion card rendered in-page";
      break;
    case "next-actions":
      statusEl.textContent = "next actions rendered in-page";
      break;
    case "profile-nav":
      statusEl.textContent = `profile: ${payload.profileHandle ?? "?"}`;
      break;
    case "dialog-mode":
      break;
    case "cron-mode":
      cronEnabled = payload.cronEnabled ?? cronEnabled;
      autoModeBtnEl.textContent = `Auto-mode: ${cronEnabled ? "ON" : "OFF"}`;
      break;
    case "passive-mode":
      passiveEnabled = payload.passiveEnabled ?? passiveEnabled;
      passiveModeBtnEl.textContent = `Magical click: ${passiveEnabled ? "ON" : "OFF"}`;
      break;
    case "cron-tick":
      cronTickBannerEl.textContent = `\u23f0 cron active${payload.taskHint ? `: ${payload.taskHint}` : ""}`;
      cronTickBannerEl.classList.remove("hidden");
      break;
    case "cron-done":
      cronTickBannerEl.classList.add("hidden");
      cronTickBannerEl.textContent = "";
      break;
  }
}

startEl.addEventListener("click", () => {
  void startLinkedIn();
});
sendEl.addEventListener("click", () => {
  void sendCommand();
});
retryBtnEl.addEventListener("click", () => {
  void performRetry();
});
autoModeBtnEl.addEventListener("click", () => {
  void toggleAutoMode();
});
passiveModeBtnEl.addEventListener("click", () => {
  void togglePassiveMode();
});
autoModeBtnEl.textContent = "Auto-mode: ON";
passiveModeBtnEl.textContent = "Magical click: OFF";
commandEl.addEventListener("input", () => {
  updateSendButtonLabel();
});
commandEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    void sendCommand();
  }
});

async function boot(): Promise<void> {
  if (!windowRef.__TAURI__) {
    errorBannerEl.textContent = "__TAURI__ missing - not running inside Tauri shell";
    transition("error");
    return;
  }
  await windowRef.__TAURI__.event.listen<SseFrame>("overlay-event", (e) => handleEvent(e.payload));
  await loadIdentity();
}

void boot();
