import { t } from "./i18n.js";

type InvokeFn = <T = unknown>(cmd: string) => Promise<T>;

interface CompletionDeps {
  invoke: InvokeFn;
  surfaceToast: (message: string) => void;
}

interface BootCompletionDeps extends CompletionDeps {
  applyLanguagePref: () => Promise<void>;
}

interface NoticeResponse {
  notice: {
    fromVersion: string | null;
    version: string;
  } | null;
}

export async function showUpdateCompletion(deps: CompletionDeps): Promise<void> {
  try {
    const result = await deps.invoke<NoticeResponse>("frondose_take_update_notice");
    if (typeof result?.notice?.version !== "string") return;
    deps.surfaceToast(t("update.completed", { version: result.notice.version }));
  } catch {
    // Completion state is non-critical: never block boot or claim false success.
  }
}

export async function applyLanguageAndShowUpdateCompletion(
  deps: BootCompletionDeps,
): Promise<void> {
  await deps.applyLanguagePref();
  await showUpdateCompletion(deps);
}
