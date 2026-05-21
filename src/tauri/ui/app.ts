// P-56a M-1 SCAFFOLD: Tauri frontend. Plain HTML + tsc-compiled TS, no React/Vite.
// Invokes Rust handlers through the Tauri 2 global injected by app.withGlobalTauri.

export {};

type InvokeFn = <T = unknown>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

declare global {
  interface Window {
    __TAURI__?: {
      core: { invoke: InvokeFn };
    };
  }
}

// rev-1 Step 3b BLOCKER-B2 fix: the existing identity schema field is `fullName`, NOT `name`.
type IdentityOk = { ok: true; fullName?: string; role?: string; company?: string; headline?: string };
type IdentityErr = { ok: false; reason: string };
type IdentityResp = IdentityOk | IdentityErr;
type ChromeOk = { ok: true; chromePort: number; overlayInstalled: boolean };
type ChromeErr = { ok: false; error: string; message?: string };
type ChromeResp = ChromeOk | ChromeErr;

interface ClassListLike {
  add(token: string): void;
  remove(token: string): void;
}

interface TextElementLike {
  classList: ClassListLike;
  textContent: string | null;
}

interface ButtonElementLike extends TextElementLike {
  disabled: boolean;
  addEventListener(type: "click", listener: () => void): void;
}

interface DocumentLike {
  getElementById(id: string): TextElementLike | null;
}

const windowRef = globalThis as unknown as Window & { document: DocumentLike };

function mustGetElement<T extends TextElementLike>(id: string): T {
  const el = windowRef.document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as unknown as T;
}

const nameEl = mustGetElement<TextElementLike>("name");
const startEl = mustGetElement<ButtonElementLike>("start");
const statusEl = mustGetElement<TextElementLike>("status");

function invoke<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!windowRef.__TAURI__) throw new Error("__TAURI__ missing — not running inside Tauri shell");
  return windowRef.__TAURI__.core.invoke<T>(cmd, args);
}

async function loadIdentity(): Promise<void> {
  try {
    const r = await invoke<IdentityResp>("mai_identity");
    if (r.ok === false) {
      nameEl.classList.add("error");
      nameEl.textContent = r.reason;
      startEl.disabled = true;
      return;
    }
    nameEl.classList.remove("error");
    nameEl.textContent = r.fullName ?? "(no fullName in identity)";
  } catch (e) {
    nameEl.classList.add("error");
    nameEl.textContent = String(e);
    startEl.disabled = true;
  }
}

async function startLinkedIn(): Promise<void> {
  startEl.disabled = true;
  startEl.textContent = "Starting…";
  statusEl.textContent = "";
  try {
    const r = await invoke<ChromeResp>("mai_chrome_ensure");
    if (r.ok === false) {
      statusEl.textContent = `error: ${r.message ?? r.error}`;
    } else {
      statusEl.textContent = `Chrome on port ${r.chromePort}, overlay ${
        r.overlayInstalled ? "installed" : "skipped"
      }.`;
    }
  } catch (e) {
    statusEl.textContent = String(e);
  } finally {
    startEl.disabled = false;
    startEl.textContent = "Start LinkedIn";
  }
}

startEl.addEventListener("click", () => {
  void startLinkedIn();
});
void loadIdentity();
