/**
 * P-28.5 Step 4a — T-DGL.1..11
 *
 * Tests for dispatch_google_login server tool (src/tools/server/dispatchGoogleLogin.ts).
 * Gate coverage:
 *   G-P28.5.9  (parameter schema = {workerId} only, no credentials)
 *   G-P28.5.10 (resolves worker → persona → googleAccountRef → getGoogleAccount,
 *               composes instruction, enqueues, increments assigned_count)
 *   G-P28.5.11 (return envelope has NO password/email/twofa_link)
 *   G-P28.5.12 (error paths: unknown worker, null persona, no googleAccountRef,
 *               missing google account, null deps)
 *   G-P28.5.13 (composeGoogleLoginInstruction output: cleanup step, google sign-in,
 *               email+password, TOTP conditional, linkedin.com/feed verification)
 *
 * DI surface:
 *   - dispatchGoogleLogin(deps, workerId) — core fn (shared by tool + CLI)
 *   - makeDispatchGoogleLoginTool(deps).execute({workerId}) — Vercel tool wrapper
 * Both take DispatchGoogleLoginDeps with explicit `:memory:` DB handles + tmp personasDir.
 *
 * Test ordering per §5.2: T-DGL.1..9, T-DGL.11, T-DGL.10 (plan canonical order).
 *
 * CREDENTIAL PLACEHOLDER POLICY (C-5, inherited from P-28):
 *   password   → "PLACEHOLDER"
 *   twofa_link → "https://2fa.show/PLACEHOLDER"
 *   email      → "acct@example.com"
 *   NEVER a real password / live 2fa.show URL / real SMS link.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { addGoogleAccount, getGoogleAccount, openCredentialsDb } from "../../src/persistence/credentialLibrary.js";
import { personaTemplateSchema, writePersonaTemplate } from "../../src/persistence/personaLibrary.js";
import { openServerInboxDb } from "../../src/persistence/serverInbox.js";
import { addWorker, openWorkersDb } from "../../src/persistence/workersRegistry.js";
import {
  type DispatchGoogleLoginDeps,
  dispatchGoogleLogin,
  makeDispatchGoogleLoginTool,
} from "../../src/tools/server/dispatchGoogleLogin.js";
import { cleanupTmpDir } from "../_helpers/tmp";

function makeTmpDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "mai-p28.5-dgl-"));
  return { dir, cleanup: () => cleanupTmpDir(dir) };
}

/** Build standard `:memory:` deps with worker 'w1' active, persona 'acme-bd',
 *  google account 'g1' (placeholder credentials). */
function makeFullDeps(dir: string): DispatchGoogleLoginDeps {
  const personasDir = join(dir, "personas");
  mkdirSync(personasDir, { recursive: true });

  const workersDb = openWorkersDb(join(dir, "workers.sqlite"));
  addWorker(workersDb, "w1", "token-w1", undefined, "acme-bd");

  const serverInboxDb = openServerInboxDb(join(dir, "inbox.sqlite"));

  const credentialsDb = openCredentialsDb(":memory:");
  addGoogleAccount(credentialsDb, {
    id: "g1",
    email: "acct@example.com",
    password: "PLACEHOLDER",
    recovery_email: null,
    phone: null,
    sms_link: null,
    twofa_link: "https://2fa.show/PLACEHOLDER",
    label: null,
  });

  // Write persona file with googleAccountRef pointing to 'g1'
  writePersonaTemplate(
    personasDir,
    "acme-bd",
    personaTemplateSchema.parse({
      fullName: "BD Alice",
      role: "BD",
      company: "Acme",
      priorities: [],
      traits: [],
      googleAccountRef: "g1",
      updatedAt: new Date().toISOString(),
    }),
  );

  return { workersDb, serverInboxDb, credentialsDb, personasDir };
}

// ─── T-DGL.1 ──────────────────────────────────────────────────────────────────

describe("dispatch_google_login: happy path — enqueue + assigned_count increment (G-P28.5.10)", () => {
  it("T-DGL.1: given workersDb(w1,acme-bd), credentialsDb(g1,assigned_count=0), serverInboxDb; when dispatchGoogleLogin({workerId:'w1'}); then worker_pending has 1 row; result.ok===true; g1.assigned_count===1", () => {
    // Given: in-memory workersDb with worker 'w1' active, persona='acme-bd'
    //        personasDir with acme-bd.json carrying googleAccountRef:'g1'
    //        in-memory credentialsDb with google account 'g1' (assigned_count=0)
    //        in-memory serverInboxDb
    // When:  dispatchGoogleLogin(deps, 'w1')
    // Then:  result.ok===true; result.queuedId is a positive integer
    //        SELECT COUNT(*) FROM worker_pending WHERE worker_id='w1' === 1
    //        getGoogleAccount(credentialsDb, 'g1').assigned_count === 1 (C-2 increment)
    const { dir, cleanup } = makeTmpDir();
    try {
      const deps = makeFullDeps(dir);
      const result = dispatchGoogleLogin(deps, "w1");
      assert.ok(result.ok === true, "T-DGL.1: result.ok===true");
      if (result.ok) {
        assert.ok(typeof result.queuedId === "number" && result.queuedId >= 1, "T-DGL.1: queuedId >= 1");
        assert.equal(result.workerId, "w1", "T-DGL.1: workerId matches");
      }
      const count = (
        deps.serverInboxDb!.prepare("SELECT COUNT(*) AS c FROM worker_pending WHERE worker_id='w1'").get() as {
          c: number;
        }
      ).c;
      assert.equal(count, 1, "T-DGL.1: 1 row enqueued in worker_pending");
      // C-2: assigned_count incremented
      const acct = getGoogleAccount(deps.credentialsDb!, "g1");
      assert.equal(acct?.assigned_count, 1, "T-DGL.1: g1.assigned_count===1 (C-2)");
    } finally {
      cleanup();
    }
  });
});

// ─── T-DGL.2 ──────────────────────────────────────────────────────────────────

describe("dispatch_google_login: return envelope has NO credential values (G-P28.5.11)", () => {
  it("T-DGL.2: given same full deps; when dispatchGoogleLogin; then JSON.stringify(result) contains NONE of g1.password/email/twofa_link", () => {
    // Given: same full deps as T-DGL.1
    // When:  dispatchGoogleLogin(deps, 'w1') → result
    // Then:  JSON.stringify(result) does NOT contain 'PLACEHOLDER', 'acct@example.com',
    //        or '2fa.show/PLACEHOLDER' — credential isolation (G-P28.5.11)
    const { dir, cleanup } = makeTmpDir();
    try {
      const deps = makeFullDeps(dir);
      const result = dispatchGoogleLogin(deps, "w1");
      assert.ok(result.ok === true, "T-DGL.2: dispatch succeeded");
      const json = JSON.stringify(result);
      assert.ok(!json.includes("PLACEHOLDER"), "T-DGL.2: password 'PLACEHOLDER' not in result JSON");
      assert.ok(!json.includes("acct@example.com"), "T-DGL.2: email not in result JSON");
      assert.ok(!json.includes("2fa.show"), "T-DGL.2: twofa_link not in result JSON");
    } finally {
      cleanup();
    }
  });
});

// ─── T-DGL.3 ──────────────────────────────────────────────────────────────────

describe("dispatch_google_login: enqueued instruction contains required steps (G-P28.5.13)", () => {
  it("T-DGL.3: given full deps with twofa_link set; when dispatched; enqueued worker_pending.content contains cleanup step, email, password, twofa_link, linkedin.com/feed verification", () => {
    // Given: full deps (g1 has twofa_link:'https://2fa.show/PLACEHOLDER')
    // When:  dispatchGoogleLogin(deps, 'w1'); read back the worker_pending row
    // Then:  content includes 'clear_cookies', 'acct@example.com', 'PLACEHOLDER' (password),
    //        '2fa.show/PLACEHOLDER', 'linkedin.com/feed'
    const { dir, cleanup } = makeTmpDir();
    try {
      const deps = makeFullDeps(dir);
      const result = dispatchGoogleLogin(deps, "w1");
      assert.ok(result.ok === true, "T-DGL.3: dispatch succeeded");
      if (result.ok) {
        const row = deps.serverInboxDb!.prepare("SELECT content FROM worker_pending WHERE id=?").get(result.queuedId) as
          | { content: string }
          | undefined;
        assert.ok(row !== undefined, "T-DGL.3: enqueued row found in worker_pending");
        const content = row!.content;
        assert.ok(content.includes("clear_cookies"), "T-DGL.3: cleanup step present");
        assert.ok(content.includes("acct@example.com"), "T-DGL.3: email present");
        assert.ok(content.includes("PLACEHOLDER"), "T-DGL.3: password present");
        assert.ok(content.includes("2fa.show/PLACEHOLDER"), "T-DGL.3: twofa_link navigate step present");
        assert.ok(content.includes("linkedin.com/feed"), "T-DGL.3: linkedin.com/feed verification step present");
      }
    } finally {
      cleanup();
    }
  });
});

// ─── T-DGL.4 ──────────────────────────────────────────────────────────────────

describe("dispatch_google_login error: unknown workerId (G-P28.5.12a)", () => {
  it("T-DGL.4: given workerId:'ghost' not in workersDb, when dispatchGoogleLogin, then {ok:false, error} naming unknown worker; nothing enqueued", () => {
    // Given: workersDb with only 'w1'; serverInboxDb empty; credentialsDb with 'g1'
    // When:  dispatchGoogleLogin(deps, 'ghost')
    // Then:  result.ok===false; result.error mentions 'ghost'; worker_pending count===0
    const { dir, cleanup } = makeTmpDir();
    try {
      const deps = makeFullDeps(dir);
      const result = dispatchGoogleLogin(deps, "ghost");
      assert.equal(result.ok, false, "T-DGL.4: result.ok===false");
      if (!result.ok) {
        assert.ok(result.error.includes("ghost"), "T-DGL.4: error names unknown worker 'ghost'");
      }
      const count = (deps.serverInboxDb!.prepare("SELECT COUNT(*) AS c FROM worker_pending").get() as { c: number }).c;
      assert.equal(count, 0, "T-DGL.4: nothing enqueued (0 rows in worker_pending)");
    } finally {
      cleanup();
    }
  });
});

// ─── T-DGL.5 ──────────────────────────────────────────────────────────────────

describe("dispatch_google_login error: worker has null persona (G-P28.5.12b)", () => {
  it("T-DGL.5: given worker 'w2' active with persona=null, when dispatchGoogleLogin('w2'), then {ok:false, error} about missing persona", () => {
    // Given: workersDb with worker 'w2' active but persona=undefined (no persona column)
    //        serverInboxDb + credentialsDb present
    // When:  dispatchGoogleLogin(deps, 'w2')
    // Then:  result.ok===false; result.error mentions missing persona
    const { dir, cleanup } = makeTmpDir();
    try {
      // Build deps with w2 having no persona (addWorker with no persona arg)
      const personasDir = join(dir, "personas");
      mkdirSync(personasDir, { recursive: true });
      const workersDb = openWorkersDb(join(dir, "workers.sqlite"));
      addWorker(workersDb, "w2", "token-w2"); // no persona arg → null
      const serverInboxDb = openServerInboxDb(join(dir, "inbox.sqlite"));
      const credentialsDb = openCredentialsDb(":memory:");
      const deps: DispatchGoogleLoginDeps = { workersDb, serverInboxDb, credentialsDb, personasDir };
      const result = dispatchGoogleLogin(deps, "w2");
      assert.equal(result.ok, false, "T-DGL.5: result.ok===false");
      if (!result.ok) {
        assert.ok(result.error.includes("persona"), "T-DGL.5: error mentions missing persona");
      }
    } finally {
      cleanup();
    }
  });
});

// ─── T-DGL.6 ──────────────────────────────────────────────────────────────────

describe("dispatch_google_login error: persona has no googleAccountRef (G-P28.5.12c)", () => {
  it("T-DGL.6: given persona 'no-ref' with no googleAccountRef field, when dispatchGoogleLogin('w3'), then {ok:false, error}", () => {
    // Given: worker 'w3' with persona='no-ref'; persona file has no googleAccountRef
    //        credentialsDb present but empty
    // When:  dispatchGoogleLogin(deps, 'w3')
    // Then:  result.ok===false; result.error mentions missing googleAccountRef
    const { dir, cleanup } = makeTmpDir();
    try {
      const personasDir = join(dir, "personas");
      mkdirSync(personasDir, { recursive: true });
      const workersDb = openWorkersDb(join(dir, "workers.sqlite"));
      addWorker(workersDb, "w3", "token-w3", undefined, "no-ref");
      writePersonaTemplate(
        personasDir,
        "no-ref",
        personaTemplateSchema.parse({
          fullName: "No Ref Person",
          role: "BD",
          company: "X",
          priorities: [],
          traits: [],
          updatedAt: new Date().toISOString(),
          // No googleAccountRef
        }),
      );
      const serverInboxDb = openServerInboxDb(join(dir, "inbox.sqlite"));
      const credentialsDb = openCredentialsDb(":memory:");
      const deps: DispatchGoogleLoginDeps = { workersDb, serverInboxDb, credentialsDb, personasDir };
      const result = dispatchGoogleLogin(deps, "w3");
      assert.equal(result.ok, false, "T-DGL.6: result.ok===false");
      if (!result.ok) {
        assert.ok(result.error.includes("googleAccountRef"), "T-DGL.6: error mentions missing googleAccountRef");
      }
    } finally {
      cleanup();
    }
  });
});

// ─── T-DGL.7 ──────────────────────────────────────────────────────────────────

describe("dispatch_google_login error: googleAccountRef resolves to no DB row (G-P28.5.12d)", () => {
  it("T-DGL.7: given persona 'ref-missing' with googleAccountRef:'does-not-exist' and empty credentialsDb, when dispatchGoogleLogin('w4'), then {ok:false, error}", () => {
    // Given: worker 'w4', persona 'ref-missing' with googleAccountRef:'does-not-exist'
    //        credentialsDb has no 'does-not-exist' row
    // When:  dispatchGoogleLogin(deps, 'w4')
    // Then:  result.ok===false; result.error mentions 'does-not-exist'
    const { dir, cleanup } = makeTmpDir();
    try {
      const personasDir = join(dir, "personas");
      mkdirSync(personasDir, { recursive: true });
      const workersDb = openWorkersDb(join(dir, "workers.sqlite"));
      addWorker(workersDb, "w4", "token-w4", undefined, "ref-missing");
      writePersonaTemplate(
        personasDir,
        "ref-missing",
        personaTemplateSchema.parse({
          fullName: "Ref Missing",
          role: "BD",
          company: "X",
          priorities: [],
          traits: [],
          googleAccountRef: "does-not-exist",
          updatedAt: new Date().toISOString(),
        }),
      );
      const serverInboxDb = openServerInboxDb(join(dir, "inbox.sqlite"));
      const credentialsDb = openCredentialsDb(":memory:"); // empty — no 'does-not-exist' row
      const deps: DispatchGoogleLoginDeps = { workersDb, serverInboxDb, credentialsDb, personasDir };
      const result = dispatchGoogleLogin(deps, "w4");
      assert.equal(result.ok, false, "T-DGL.7: result.ok===false");
      if (!result.ok) {
        assert.ok(result.error.includes("does-not-exist"), "T-DGL.7: error names missing google account ref");
      }
    } finally {
      cleanup();
    }
  });
});

// ─── T-DGL.8 ──────────────────────────────────────────────────────────────────

describe("dispatch_google_login error: null deps → graceful envelope (G-P28.5.12e)", () => {
  it("T-DGL.8: given credentialsDb=null (or workersDb=null or serverInboxDb=null), when dispatchGoogleLogin, then {ok:false, error} graceful — no throw", () => {
    // Given: deps with credentialsDb=null (and workersDb + serverInboxDb also null)
    // When:  dispatchGoogleLogin(deps, 'w1')
    // Then:  result.ok===false; result.error mentions unavailability; no throw
    const { dir, cleanup } = makeTmpDir();
    try {
      const personasDir = join(dir, "personas");
      mkdirSync(personasDir, { recursive: true });
      const deps: DispatchGoogleLoginDeps = {
        workersDb: null,
        serverInboxDb: null,
        credentialsDb: null,
        personasDir,
      };
      const result = dispatchGoogleLogin(deps, "w1");
      assert.equal(result.ok, false, "T-DGL.8: result.ok===false — graceful envelope, no throw");
      if (!result.ok) {
        assert.ok(result.error.length > 0, "T-DGL.8: error message non-empty");
      }
    } finally {
      cleanup();
    }
  });
});

// ─── T-DGL.9 ──────────────────────────────────────────────────────────────────

describe("dispatch_google_login: nullable sms/recovery/phone omitted from instruction when null (G-P28.5.13)", () => {
  it("T-DGL.9: given google account with sms_link/recovery_email/phone all null but twofa_link set; when dispatched; instruction omits SMS/recovery/phone lines; TOTP navigate step IS present", () => {
    // Given: google account g2: email, password (PLACEHOLDER), twofa_link set,
    //        sms_link=null, recovery_email=null, phone=null
    // When:  dispatchGoogleLogin(deps, 'w5')
    // Then:  worker_pending.content does NOT contain 'sms_link'/'recovery_email'/'phone' literal keys
    //        worker_pending.content DOES contain '2fa.show/PLACEHOLDER' (twofa navigate step)
    const { dir, cleanup } = makeTmpDir();
    try {
      const personasDir = join(dir, "personas");
      mkdirSync(personasDir, { recursive: true });
      const workersDb = openWorkersDb(join(dir, "workers.sqlite"));
      addWorker(workersDb, "w5", "token-w5", undefined, "twofa-persona");
      writePersonaTemplate(
        personasDir,
        "twofa-persona",
        personaTemplateSchema.parse({
          fullName: "2FA Person",
          role: "BD",
          company: "X",
          priorities: [],
          traits: [],
          googleAccountRef: "g2",
          updatedAt: new Date().toISOString(),
        }),
      );
      const serverInboxDb = openServerInboxDb(join(dir, "inbox.sqlite"));
      const credentialsDb = openCredentialsDb(":memory:");
      addGoogleAccount(credentialsDb, {
        id: "g2",
        email: "acct@example.com",
        password: "PLACEHOLDER",
        recovery_email: null,
        phone: null,
        sms_link: null,
        twofa_link: "https://2fa.show/PLACEHOLDER",
        label: null,
      });
      const deps: DispatchGoogleLoginDeps = { workersDb, serverInboxDb, credentialsDb, personasDir };
      const result = dispatchGoogleLogin(deps, "w5");
      assert.ok(result.ok === true, "T-DGL.9: dispatch succeeded");
      if (result.ok) {
        const row = deps.serverInboxDb!.prepare("SELECT content FROM worker_pending WHERE id=?").get(result.queuedId) as
          | { content: string }
          | undefined;
        assert.ok(row !== undefined, "T-DGL.9: enqueued row found");
        const content = row!.content;
        // twofa_link IS set → navigate step present
        assert.ok(content.includes("2fa.show/PLACEHOLDER"), "T-DGL.9: twofa_link navigate step present");
        // null fields → those lines OMITTED from instruction
        assert.ok(!content.includes("recovery email"), "T-DGL.9: no recovery_email line when null");
        assert.ok(!content.includes("phone number"), "T-DGL.9: no phone line when null");
        assert.ok(!content.includes("SMS-receive"), "T-DGL.9: no sms_link line when null");
      }
    } finally {
      cleanup();
    }
  });
});

// ─── T-DGL.11 (plan ordering: T-DGL.11 comes before T-DGL.10) ─────────────────

describe("dispatch_google_login: twofa_link=null → STOP instruction, no navigate placeholder (G-P28.5.13 C-1)", () => {
  it("T-DGL.11: given google account with twofa_link=null (C-1); when dispatched; instruction contains STOP/report line and does NOT contain a navigate_to_url-to-placeholder string", () => {
    // Given: google account with twofa_link=null (C-1: no TOTP link configured)
    // When:  dispatchGoogleLogin(deps, 'w6')
    // Then:  worker_pending.content contains 'STOP and report' (or similar)
    //        worker_pending.content does NOT contain 'navigate_to_url to (no twofa' style placeholder
    //        (C-1 fix: the step is conditional on twofa_link being non-null)
    const { dir, cleanup } = makeTmpDir();
    try {
      const personasDir = join(dir, "personas");
      mkdirSync(personasDir, { recursive: true });
      const workersDb = openWorkersDb(join(dir, "workers.sqlite"));
      addWorker(workersDb, "w6", "token-w6", undefined, "no-totp-persona");
      writePersonaTemplate(
        personasDir,
        "no-totp-persona",
        personaTemplateSchema.parse({
          fullName: "No TOTP Person",
          role: "BD",
          company: "X",
          priorities: [],
          traits: [],
          googleAccountRef: "g3",
          updatedAt: new Date().toISOString(),
        }),
      );
      const serverInboxDb = openServerInboxDb(join(dir, "inbox.sqlite"));
      const credentialsDb = openCredentialsDb(":memory:");
      addGoogleAccount(credentialsDb, {
        id: "g3",
        email: "acct@example.com",
        password: "PLACEHOLDER",
        recovery_email: null,
        phone: null,
        sms_link: null,
        twofa_link: null, // C-1: null twofa_link
        label: null,
      });
      const deps: DispatchGoogleLoginDeps = { workersDb, serverInboxDb, credentialsDb, personasDir };
      const result = dispatchGoogleLogin(deps, "w6");
      assert.ok(result.ok === true, "T-DGL.11: dispatch succeeded");
      if (result.ok) {
        const row = deps.serverInboxDb!.prepare("SELECT content FROM worker_pending WHERE id=?").get(result.queuedId) as
          | { content: string }
          | undefined;
        assert.ok(row !== undefined, "T-DGL.11: enqueued row found");
        const content = row!.content;
        // C-1: twofa_link=null → STOP instruction instead of navigate_to_url
        assert.ok(content.includes("STOP and report this failure"), "T-DGL.11: STOP instruction present");
        assert.ok(!content.includes("2fa.show"), "T-DGL.11: no 2fa.show URL when twofa_link=null");
      }
    } finally {
      cleanup();
    }
  });
});

// ─── T-DGL.10 ─────────────────────────────────────────────────────────────────

describe("dispatch_google_login: parameter schema has exactly {workerId} — no credentials (G-P28.5.9)", () => {
  it("T-DGL.10: given makeDispatchGoogleLoginTool(deps).parameters; when inspected; schema has exactly one key 'workerId'; no 'password'/'email'/'twofa_link'/'googleAccountId' key", () => {
    // Given: makeDispatchGoogleLoginTool(deps) — the Vercel tool wrapper
    // When:  Object.keys(tool.parameters.shape) or tool.parameters.safeParse({workerId:'w1'})
    // Then:  tool.parameters has exactly one required field: 'workerId'
    //        'password'/'email'/'twofa_link' keys are absent (D-4: LLM never holds credentials)
    const { dir, cleanup } = makeTmpDir();
    try {
      const personasDir = join(dir, "personas");
      mkdirSync(personasDir, { recursive: true });
      const workersDb = openWorkersDb(join(dir, "workers.sqlite"));
      const serverInboxDb = openServerInboxDb(join(dir, "inbox.sqlite"));
      const credentialsDb = openCredentialsDb(":memory:");
      const deps: DispatchGoogleLoginDeps = { workersDb, serverInboxDb, credentialsDb, personasDir };
      const tool = makeDispatchGoogleLoginTool(deps);
      const keys = Object.keys(tool.parameters.shape);
      assert.deepEqual(keys, ["workerId"], "T-DGL.10: schema has exactly one key 'workerId'");
      assert.ok(!keys.includes("password"), "T-DGL.10: 'password' absent from schema (D-4)");
      assert.ok(!keys.includes("email"), "T-DGL.10: 'email' absent from schema (D-4)");
      assert.ok(!keys.includes("twofa_link"), "T-DGL.10: 'twofa_link' absent from schema (D-4)");
      // Schema validation: valid workerId accepted; empty string rejected (z.string().min(1))
      const valid = tool.parameters.safeParse({ workerId: "w1" });
      assert.equal(valid.success, true, "T-DGL.10: valid workerId accepted");
      const invalid = tool.parameters.safeParse({ workerId: "" });
      assert.equal(invalid.success, false, "T-DGL.10: empty workerId rejected by min(1)");
    } finally {
      cleanup();
    }
  });
});
