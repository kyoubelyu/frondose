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
type TurnBusy = { ok: false; reason: "turn_in_progress"; turnId: string };
type TurnInvalid = { ok: false; reason: "missing_prompt" };
type TurnResp = TurnOk | TurnBusy | TurnInvalid;

type SseFrame =
  | { type: "tool-call"; turnId: string; toolName: string }
  | { type: "text"; turnId: string; chunk: string }
  | { type: "step-done"; turnId: string; toolNames: string[] }
  | { type: "done"; turnId: string; finishReason: string }
  | { type: "error"; turnId?: string; message: string }
  | { type: "overlay-reconnected" }
  | { type: "overlay-event"; event: unknown };

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

type AppState = "F-identity-missing" | "H-chrome-needed" | "A-idle" | "C-running" | "I-error";
let appState: AppState = "H-chrome-needed";
let currentTurnId: string | null = null;

const nameEl = mustGet<TextElementLike>("name");
const startEl = mustGet<ButtonElementLike>("start");
const statusEl = mustGet<TextElementLike>("status");
const commandEl = mustGet<InputElementLike>("command-input");
const sendEl = mustGet<ButtonElementLike>("send-btn");
const tickerEl = mustGet<TextElementLike>("ticker");
const outputEl = mustGet<TextElementLike>("output");
const errorBannerEl = mustGet<TextElementLike>("error-banner");

function invoke<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!windowRef.__TAURI__) throw new Error("__TAURI__ missing - not running inside Tauri shell");
  return windowRef.__TAURI__.core.invoke<T>(cmd, args);
}

function transition(next: AppState): void {
  appState = next;
  startEl.classList.toggle("hidden", next !== "H-chrome-needed");
  commandEl.classList.toggle("hidden", next !== "A-idle" && next !== "C-running");
  sendEl.classList.toggle("hidden", next !== "A-idle" && next !== "C-running");
  tickerEl.classList.toggle("hidden", next !== "C-running");
  outputEl.classList.toggle("hidden", next === "F-identity-missing" || next === "H-chrome-needed");
  errorBannerEl.classList.toggle("hidden", next !== "I-error");
  commandEl.disabled = next !== "A-idle";
  sendEl.disabled = next !== "A-idle";
  if (next === "A-idle") {
    sendEl.textContent = "Send";
    commandEl.value = "";
  } else if (next === "C-running") {
    sendEl.textContent = "Cancel";
    sendEl.disabled = false;
  }
}

async function loadIdentity(): Promise<void> {
  try {
    const r = await invoke<IdentityResp>("mai_identity");
    if (r.ok === false) {
      nameEl.classList.add("error");
      nameEl.textContent = r.reason;
      transition("F-identity-missing");
      return;
    }
    nameEl.classList.remove("error");
    nameEl.textContent = r.fullName ?? "(no fullName in identity)";
    transition("H-chrome-needed");
  } catch (e) {
    nameEl.classList.add("error");
    nameEl.textContent = String(e);
    errorBannerEl.textContent = `boot error: ${String(e)}`;
    transition("I-error");
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
    transition("A-idle");
  } catch (e) {
    statusEl.textContent = String(e);
    startEl.disabled = false;
    startEl.textContent = "Start LinkedIn";
  }
}

async function sendCommand(): Promise<void> {
  if (appState === "C-running" && currentTurnId !== null) {
    try {
      await invoke("mai_agent_abort");
    } catch {
      // Cancellation is best-effort; the SSE error/done event owns UI recovery.
    }
    return;
  }

  if (appState !== "A-idle") return;
  const prompt = commandEl.value.trim();
  if (!prompt) return;
  try {
    const r = await invoke<TurnResp>("mai_agent_turn", { prompt });
    if (r.ok === false) {
      errorBannerEl.textContent = `turn rejected: ${r.reason}`;
      transition("I-error");
      return;
    }
    currentTurnId = r.turnId;
    outputEl.textContent = "";
    tickerEl.textContent = "starting...";
    transition("C-running");
  } catch (e) {
    errorBannerEl.textContent = `invoke failed: ${String(e)}`;
    transition("I-error");
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
        transition("A-idle");
      }
      break;
    case "error":
      errorBannerEl.textContent = `agent error: ${payload.message}`;
      currentTurnId = null;
      transition("I-error");
      break;
    case "overlay-reconnected":
      statusEl.textContent = "overlay reconnected";
      setTimeout(() => {
        statusEl.textContent = "Chrome on port 9222";
      }, 2000);
      break;
    case "overlay-event":
      break;
  }
}

startEl.addEventListener("click", () => {
  void startLinkedIn();
});
sendEl.addEventListener("click", () => {
  void sendCommand();
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
    transition("I-error");
    return;
  }
  await windowRef.__TAURI__.event.listen<SseFrame>("overlay-event", (e) => handleEvent(e.payload));
  await loadIdentity();
}

void boot();
