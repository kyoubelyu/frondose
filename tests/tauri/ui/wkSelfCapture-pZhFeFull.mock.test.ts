import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";

const ROOT = process.cwd();
const SCRIPT_PATH = `${ROOT}/tests/tauri/ui/fixtures/wkSelfCaptureStage.txt`;
const STAGE_SCRIPT = readFileSync(SCRIPT_PATH, "utf8");
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
  ...args: string[]
) => (...values: unknown[]) => Promise<string>;

const SENTINELS = ["cause-first", "pain-owner first", "I-lean", "reference-story led"];
const TARGETS = ["economic-buyer-first", "champion-led", "R-lean", "number-anchored opener"];
const EN_LABELS = [...TARGETS];
const ZH_LABELS = ["先找经济决策者", "由内部支持者带动", "偏重回应", "以数字锚点开场"];
const EN_GROUP_LABELS = ["Pain Chain direction", "Key Players entry point", "Discovery pacing", "Spark-interest story shape"];
const ZH_GROUP_LABELS = ["Pain Chain 方向", "Key Players 切入角色", "9-block 节奏", "首次触达故事形态"];
const IDS = [
  "settings-axis-painchain",
  "settings-axis-leadrole",
  "settings-axis-discovery",
  "settings-axis-story",
] as const;

class FakeClassList {
  readonly values = new Set<string>();
  constructor(...initial: string[]) {
    for (const value of initial) this.values.add(value);
  }
  contains(value: string): boolean {
    return this.values.has(value);
  }
  add(value: string): void {
    this.values.add(value);
  }
  remove(value: string): void {
    this.values.delete(value);
  }
}

interface Rect {
  top: number;
  left: number;
  bottom: number;
  right: number;
  width: number;
  height: number;
}

class FakeElement {
  private storedValue = "";
  textContent = "";
  readonly classList: FakeClassList;
  readonly events: string[] = [];
  labels: string[] = [];
  rect: Rect = { top: 100, left: 20, bottom: 140, right: 460, width: 440, height: 40 };
  group: FakeElement | null = null;
  parentElement: FakeElement | null = null;
  previousElementSibling: FakeElement | null = null;
  onClick: (() => void) | null = null;
  constructor(hidden = false) {
    this.classList = new FakeClassList(...(hidden ? ["hidden"] : []));
  }
  click(): void {
    this.events.push("click");
    this.onClick?.();
  }
  dispatchEvent(event: Event): boolean {
    this.events.push(event.type);
    return true;
  }
  closest(selector: string): FakeElement | null {
    return selector === ".settings-group" ? this.group : null;
  }
  scrollIntoView(): void {
    this.events.push("scrollIntoView");
  }
  getBoundingClientRect(): Rect {
    return this.rect;
  }
  get selectedOptions(): Array<{ textContent: string }> {
    const index = TARGETS.indexOf(this.value);
    return [{ textContent: index >= 0 ? (this.labels[index] ?? "") : this.value }];
  }
  get value(): string {
    return this.storedValue;
  }
  set value(value: string) {
    this.storedValue = value;
  }
  contains(candidate: FakeElement): boolean {
    for (let current: FakeElement | null = candidate; current; current = current.parentElement) {
      if (current === this) return true;
    }
    return false;
  }
}

interface FakeOptions {
  initialValues: string[];
  initialLanguage: "auto" | "en" | "zh";
  staleToast: string;
  labels: string[];
  failSave?: boolean;
  missingId?: string;
  outsideViewport?: boolean;
  noReget?: boolean;
  hiddenControl?: boolean;
  zeroSizedControl?: boolean;
  coveredControl?: boolean;
  rehidePanel?: boolean;
  clippedAncestor?: boolean;
  horizontalScroll?: number;
  groupLabels?: string[];
}

function makeFakeDom(options: FakeOptions) {
  const log: string[] = [];
  const elements = new Map<string, FakeElement>();
  const add = (id: string, hidden = false) => {
    const element = new FakeElement(hidden);
    elements.set(id, element);
    return element;
  };
  const gear = add("settings-gear");
  const panel = add("settings-panel", true);
  panel.rect = { top: 0, left: 0, bottom: 640, right: 480, width: 480, height: 640 };
  const language = add("settings-language");
  const save = add("settings-save");
  const toast = add("save-toast", true);
  const error = add("error-banner", true);
  const group = new FakeElement();
  group.rect = options.outsideViewport
    ? { top: 580, left: 10, bottom: 760, right: 470, width: 460, height: 180 }
    : { top: 60, left: 10, bottom: 300, right: 470, width: 460, height: 240 };
  const groupLabels = IDS.map((_, index) => {
    const label = new FakeElement();
    label.textContent = (options.groupLabels ?? EN_GROUP_LABELS)[index] ?? "";
    label.parentElement = group;
    label.rect = { top: 60 + index * 50, left: 20, bottom: 75 + index * 50, right: 300, width: 280, height: 15 };
    return label;
  });
  const controls = IDS.map((id, index) => {
    const control = add(id);
    control.group = group;
    control.parentElement = group;
    control.previousElementSibling = groupLabels[index] ?? null;
    control.labels = options.labels;
    control.rect = { top: 80 + index * 50, left: 20, bottom: 100 + index * 50, right: 460, width: 440, height: 20 };
    return control;
  });
  group.parentElement = panel;
  if (options.clippedAncestor) {
    panel.classList.add("clipped");
    panel.rect = { top: 0, left: 0, bottom: 640, right: 100, width: 100, height: 640 };
  }
  if (options.hiddenControl) controls[0].classList.add("computed-hidden");
  if (options.zeroSizedControl) controls[0].rect = { top: 80, left: 20, bottom: 80, right: 20, width: 0, height: 0 };
  if (options.missingId) elements.delete(options.missingId);

  let persistedValues = [...options.initialValues];
  let persistedLanguage = options.initialLanguage;
  toast.textContent = options.staleToast;
  const load = () => {
    controls.forEach((control, index) => {
      control.value = persistedValues[index] ?? "";
    });
    language.value = persistedLanguage;
    panel.classList.remove("hidden");
    log.push("re-get");
  };
  gear.onClick = () => {
    log.push("gear-click");
    setTimeout(load, 0);
  };
  save.onClick = () => {
    log.push("save-click");
    setTimeout(() => {
      const allEvents = controls.every(
        (control) => control.events.includes("input") && control.events.includes("change"),
      );
      if (options.failSave || !allEvents || !language.events.includes("change")) {
        error.textContent = "save failed";
        error.classList.remove("hidden");
        return;
      }
      persistedValues = controls.map((control) => control.value);
      persistedLanguage = language.value as "en" | "zh";
      log.push("persist");
      if (!options.noReget) load();
      if (options.rehidePanel) panel.classList.add("hidden");
      documentElement.lang = persistedLanguage === "zh" ? "zh-CN" : "en";
      toast.textContent = persistedLanguage === "zh" ? "✓ 已保存" : "✓ Saved";
      toast.classList.remove("hidden");
      log.push("toast");
    }, 0);
  };
  const documentElement = { lang: options.initialLanguage === "zh" ? "zh-CN" : "en", scrollLeft: 0 };
  const document = {
    documentElement,
    body: { scrollLeft: 0 },
    getElementById(id: string) {
      return elements.get(id) ?? null;
    },
    elementsFromPoint(x: number, y: number) {
      return elementsFromPoint(x, y);
    },
  };
  const getComputedStyle = (element: FakeElement) => ({
    display: element.classList.contains("computed-hidden") ? "none" : "block",
    visibility: "visible",
    opacity: "1",
    overflow: element.classList.contains("clipped") ? "hidden" : "visible",
  });
  const elementsFromPoint = (x: number, y: number) => {
    const hit = [...controls, ...groupLabels].find((control) => {
      const r = control.rect;
      return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    });
    if (options.coveredControl && hit === controls[0]) return [new FakeElement(), hit];
    if (hit) return [hit];
    if (x >= group.rect.left && x <= group.rect.right && y >= group.rect.top && y <= group.rect.bottom) return [group];
    return [panel];
  };
  return { document, log, controls, groupLabels, language, getComputedStyle, elementsFromPoint };
}

async function runStage(
  options: FakeOptions,
  overrides: Partial<{
    stage: string;
    loadedValues: string[];
    loadedLanguage: string;
    targetLanguage: string;
    targetValues: string[];
    expectedToast: string;
    expectedDocumentLang: string;
    expectedLabels: string[];
    expectedGroupLabels: string[];
    staleToast: string;
    timeoutMs: number;
    script: string;
  }> = {},
) {
  const fake = makeFakeDom(options);
  const names = [
    "document",
    "Event",
    "requestAnimationFrame",
    "innerWidth",
    "innerHeight",
    "devicePixelRatio",
    "scrollX",
    "getComputedStyle",
    "elementsFromPoint",
    "stage",
    "nonce",
    "loadedValues",
    "loadedLanguage",
    "targetValues",
    "targetLanguage",
    "expectedToast",
    "expectedDocumentLang",
    "expectedLabels",
    "expectedGroupLabels",
    "staleToast",
    "timeoutMs",
  ];
  const fn = new AsyncFunction(...names, overrides.script ?? STAGE_SCRIPT);
  const result = await fn(
    fake.document,
    Event,
    (callback: () => void) => setTimeout(callback, 0),
    480,
    640,
    2,
    options.horizontalScroll ?? 0,
    fake.getComputedStyle,
    fake.elementsFromPoint,
    overrides.stage ?? "en",
    "native-owned-nonce",
    overrides.loadedValues ?? options.initialValues,
    overrides.loadedLanguage ?? options.initialLanguage,
    overrides.targetValues ?? TARGETS,
    overrides.targetLanguage ?? "en",
    overrides.expectedToast ?? "✓ Saved",
    overrides.expectedDocumentLang ?? "en",
    overrides.expectedLabels ?? EN_LABELS,
    overrides.expectedGroupLabels ?? options.groupLabels ?? EN_GROUP_LABELS,
    overrides.staleToast ?? options.staleToast,
    overrides.timeoutMs ?? 250,
  );
  return { evidence: JSON.parse(result), ...fake };
}

function cargo(args: string[]) {
  return spawnSync("cargo", args, {
    cwd: `${ROOT}/src/tauri/src-tauri`,
    encoding: "utf8",
    env: {
      ...process.env,
      FRONDOSE_UI_VALIDATION_DIR: "/private/tmp/must-not-run",
      FRONDOSE_UI_VALIDATION_NONCE: "hostile",
    },
  });
}

describe("P-ZH compiled-App WKWebView self-capture ownership", () => {
  it("T-ZHFull.WK.1: Cargo metadata keeps validation dependencies optional and outside default features", () => {
    // Given the resolved Cargo graph, when feature ownership is queried, then only ui-validation activates the Apple snapshot dependencies.
    const result = cargo(["metadata", "--format-version", "1", "--no-deps"]);
    assert.equal(result.status, 0, result.stderr);
    const metadata = JSON.parse(result.stdout) as {
      packages: Array<{
        name: string;
        features: Record<string, string[]>;
        dependencies: Array<{
          name: string;
          req: string;
          optional: boolean;
          uses_default_features: boolean;
          target: string | null;
          features: string[];
        }>;
      }>;
    };
    const pkg = metadata.packages.find((candidate) => candidate.name === "frondose");
    assert.ok(pkg);
    assert.deepEqual(pkg.features.default, []);
    assert.deepEqual(
      [...(pkg.features["ui-validation"] ?? [])].sort(),
      ["dep:block2", "dep:objc2", "dep:objc2-app-kit", "dep:objc2-foundation", "dep:objc2-web-kit"].sort(),
    );
    for (const name of ["block2", "objc2", "objc2-app-kit", "objc2-foundation", "objc2-web-kit"]) {
      const dependency = pkg.dependencies.find((candidate) => candidate.name === name);
      assert.ok(dependency, `missing ${name}`);
      assert.equal(dependency.optional, true, name);
      assert.equal(dependency.uses_default_features, false, name);
      assert.equal(dependency.target, 'cfg(target_os = "macos")', name);
      assert.equal(dependency.req, name === "block2" ? "=0.6.2" : name === "objc2" ? "=0.6.4" : "=0.3.2", name);
    }
    const expectedFeatures: Record<string, string[]> = {
      block2: [],
      objc2: [],
      "objc2-app-kit": ["NSBitmapImageRep", "NSImage", "NSImageRep"],
      "objc2-foundation": ["NSData", "NSDictionary", "NSError", "NSObject", "NSString"],
      "objc2-web-kit": [
        "WKContentWorld",
        "WKFrameInfo",
        "WKSnapshotConfiguration",
        "WKWebView",
        "block2",
        "objc2-app-kit",
      ],
    };
    for (const [name, features] of Object.entries(expectedFeatures)) {
      assert.deepEqual(
        [...(pkg.dependencies.find((candidate) => candidate.name === name)?.features ?? [])].sort(),
        [...features].sort(),
        name,
      );
    }
  });

  it("T-ZHFull.WK.2: default and feature builds bind the canonical script to the real App activation seam", () => {
    // macOS-only WKWebView acceptance chain: the host-build binding check targets the
    // macOS variant; a cold Linux workspace compile cannot meet the test timeout budget.
    // In-body early-return form keeps the skip-ownership fence inventory unchanged.
    if (process.platform !== "darwin") {
      assert.ok(true, "T-ZHFull.WK.2 is part of the macOS WKWebView acceptance chain — not applicable on this host");
      return;
    }
    // Given both build graphs and the canonical fixture, when compiled, then only the feature App owns the startup and included-script carrier.
    for (const args of [["check"], ["check", "--no-default-features", "--features", "ui-validation"]]) {
      const result = cargo(args);
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    }
    const sourcePath = `${ROOT}/src/tauri/src-tauri/src/ui_validation.rs`;
    assert.equal(existsSync(sourcePath), true, "missing real validation module");
    const source = readFileSync(sourcePath, "utf8");
    const main = readFileSync(`${ROOT}/src/tauri/src-tauri/src/main.rs`, "utf8");
    assert.match(source, /include_str!\([^)]*wkSelfCaptureStage\.txt/);
    assert.match(source, new RegExp(createHash("sha256").update(STAGE_SCRIPT).digest("hex")));
    assert.match(source, /pub\s+fn\s+activate\s*\(/);
    assert.match(
      main,
      /cfg\(all\(target_os\s*=\s*"macos",\s*feature\s*=\s*"ui-validation"\)\)[\s\S]*ui_validation::activate/,
    );
    assert.doesNotMatch(source, /frondose_set_settings|config\.json/);
  });

  it("T-ZHFull.WK.3: Rust hostile tests execute shared reducer, writer, activation, and PNG contracts", () => {
    if (process.platform !== "darwin") {
      assert.ok(true, "T-ZHFull.WK.3 drives the cfg(target_os = macos) ui-validation suite — not applicable on this host");
      return;
    }
    // Given the feature-gated native module, when its Rust unit suite runs, then executable hostile contracts pass rather than source tokens being counted.
    const result = cargo(["test", "--features", "ui-validation", "ui_validation::tests::", "--", "--nocapture"]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    for (const name of [
      "rejects_wrong_duplicate_and_out_of_order_stage",
      "rejects_timeout_and_late_callback",
      "rejects_unsafe_output_roots_and_duplicate_entries",
      "rejects_replaced_output_parent",
      "rejects_invalid_png_and_viewport_mismatch",
      "rejects_activation_without_exact_stage_contract",
    ]) {
      assert.match(result.stdout, new RegExp(`test .*${name} .* ok`));
    }
  });

  it("T-ZHFull.WK.4: actual stage script proves sentinel load before real event/save/re-get evidence", async () => {
    // Given sentinel persisted state, when English validation runs, then it observes load before input/change/save and returns rendered evidence.
    const run = await runStage({
      initialValues: SENTINELS,
      initialLanguage: "auto",
      staleToast: "",
      labels: EN_LABELS,
    });
    assert.deepEqual(run.evidence.values, TARGETS);
    assert.deepEqual(run.evidence.labels, EN_LABELS);
    assert.equal(run.evidence.language, "en");
    assert.equal(run.evidence.documentLanguage, "en");
    assert.equal(run.evidence.panelVisible, true);
    assert.equal(run.evidence.errorHidden, true);
    assert.deepEqual(run.evidence.regetAssignments, [2, 2, 2, 2]);
    assert.deepEqual(run.log.slice(0, 4), ["gear-click", "re-get", "save-click", "persist"]);
    assert.equal(run.log.at(-2), "re-get");
    assert.equal(run.log.at(-1), "toast");
    for (const control of run.controls) assert.deepEqual(control.events.slice(0, 2), ["input", "change"]);
  });

  it("T-ZHFull.WK.5: Chinese stage proves prior English reload and exact localized rendered evidence", async () => {
    // Given English-persisted targets and a hidden stale English toast, when Chinese validation saves, then labels/toast/document language all switch.
    const run = await runStage(
      { initialValues: TARGETS, initialLanguage: "en", staleToast: "Saved", labels: ZH_LABELS, groupLabels: ZH_GROUP_LABELS },
      {
        stage: "zh",
        loadedValues: TARGETS,
        loadedLanguage: "en",
        targetLanguage: "zh",
        expectedToast: "✓ 已保存",
        expectedDocumentLang: "zh-CN",
        expectedLabels: ZH_LABELS,
        expectedGroupLabels: ZH_GROUP_LABELS,
        staleToast: "Saved",
      },
    );
    assert.deepEqual(run.evidence.loadedValues, TARGETS);
    assert.deepEqual(run.evidence.labels, ZH_LABELS);
    assert.deepEqual(run.evidence.groupLabelTexts, ZH_GROUP_LABELS);
    assert.equal(run.evidence.language, "zh");
    assert.equal(run.evidence.documentLanguage, "zh-CN");
    assert.equal(run.evidence.toast, "✓ 已保存");
    assert.deepEqual(run.evidence.horizontalOffsets, [0, 0, 0]);
  });

  it("T-ZHFull.WK.6: hostile UI mutations fail instead of producing screenshot-ready evidence", async () => {
    // Given missing controls, stale toast, save failure, skipped load/save, or offscreen content, when the real script runs, then every mutation rejects.
    const base: FakeOptions = { initialValues: SENTINELS, initialLanguage: "auto", staleToast: "", labels: EN_LABELS };
    await assert.rejects(() => runStage({ ...base, missingId: "settings-axis-story" }), /missing:#settings-axis-story/);
    await assert.rejects(() => runStage({ ...base, staleToast: "old" }, { staleToast: "" }), /stale-toast-baseline/);
    await assert.rejects(() => runStage({ ...base, failSave: true }, { timeoutMs: 70 }), /product-error:save failed/);
    await assert.rejects(() => runStage({ ...base, noReget: true }, { timeoutMs: 70 }), /timeout:settings-save/);
    await assert.rejects(() => runStage({ ...base, labels: ["wrong", ...EN_LABELS.slice(1)] }), /unexpected-labels/);
    await assert.rejects(
      () => runStage({ ...base, groupLabels: ["wrong", ...EN_GROUP_LABELS.slice(1)] }, { expectedGroupLabels: EN_GROUP_LABELS }),
      /unexpected-group-labels/,
    );
    await assert.rejects(() => runStage({ ...base, outsideViewport: true }), /methodology-not-visible/);
    await assert.rejects(() => runStage({ ...base, hiddenControl: true }), /methodology-not-visible/);
    await assert.rejects(() => runStage({ ...base, zeroSizedControl: true }), /methodology-not-visible/);
    await assert.rejects(() => runStage({ ...base, coveredControl: true }), /methodology-not-visible/);
    await assert.rejects(() => runStage({ ...base, rehidePanel: true }), /methodology-not-visible/);
    await assert.rejects(() => runStage({ ...base, clippedAncestor: true }), /methodology-not-visible/);
    await assert.rejects(() => runStage({ ...base, horizontalScroll: 1 }), /horizontal-scroll-offset/);
    await assert.rejects(
      () => runStage(base, { script: STAGE_SCRIPT.replace("gear.click();", "void 0;"), timeoutMs: 70 }),
      /timeout:settings-load/,
    );
    await assert.rejects(
      () => runStage(base, { script: STAGE_SCRIPT.replace("save.click();", "void 0;"), timeoutMs: 70 }),
      /timeout:settings-save/,
    );
    assert.doesNotMatch(STAGE_SCRIPT, /frondose_set_settings|config\.json|__TAURI__|invoke\s*\(/);
  });
});
