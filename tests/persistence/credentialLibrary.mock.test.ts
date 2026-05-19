/**
 * P-28 Step 4a — T-CRED.OPEN.1..2, T-CRED.LLM.1..5, T-CRED.GOOG.1..4
 *
 * Tests for openCredentialsDb + CRUD functions in src/persistence/credentialLibrary.ts.
 * Gate coverage: G-P28.14 (open + schema), G-P28.15 (addLlmKey),
 *                G-P28.16 (listLlmKeys + getLlmKey), G-P28.17 (removeLlmKey),
 *                G-P28.18 (duplicate id rejected), G-P28.19 (addGoogleAccount),
 *                G-P28.20 (listGoogleAccounts), G-P28.21 (removeGoogleAccount),
 *                G-P28.22 (assigned_count increment)
 *
 * CREDENTIAL PLACEHOLDER POLICY (C-5): All fixtures use obvious placeholders ONLY.
 *   api_key    → "sk-PLACEHOLDER"
 *   password   → "PLACEHOLDER"
 *   twofa_link → "https://2fa.show/PLACEHOLDER"
 * NEVER a real API key, real password, or live SMS/2FA URL.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  addGoogleAccount,
  addLlmKey,
  getGoogleAccount,
  getLlmKey,
  incrementGoogleAccountAssignedCount,
  incrementLlmKeyAssignedCount,
  listGoogleAccounts,
  listLlmKeys,
  openCredentialsDb,
  removeGoogleAccount,
  removeLlmKey,
} from "../../src/persistence/credentialLibrary.js";

// ─── T-CRED.OPEN.1 ────────────────────────────────────────────────────────────

describe("openCredentialsDb: opens :memory: and creates schema (G-P28.14)", () => {
  it("T-CRED.OPEN.1: given path=':memory:', openCredentialsDb returns a Database with llm_keys + google_accounts tables", () => {
    // Given: path = ":memory:" (in-process only, no file)
    // When:  openCredentialsDb(":memory:")
    // Then:  returns Database; SELECT name FROM sqlite_master returns llm_keys + google_accounts; no throw
    const db = openCredentialsDb(":memory:");
    try {
      const tables = (
        db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[]
      ).map((r) => r.name);
      assert.ok(tables.includes("llm_keys"), "T-CRED.OPEN.1: llm_keys table must exist (G-P28.14)");
      assert.ok(tables.includes("google_accounts"), "T-CRED.OPEN.1: google_accounts table must exist (G-P28.14)");
    } finally {
      db.close();
    }
  });
});

// ─── T-CRED.OPEN.2 ────────────────────────────────────────────────────────────

describe("openCredentialsDb: idempotent schema migration (G-P28.14)", () => {
  it("T-CRED.OPEN.2: given :memory: db opened twice (simulate re-open), schema migration is idempotent — no duplicate column error", () => {
    // Given: openCredentialsDb(":memory:") called once (creates schema)
    // When:  second openCredentialsDb(":memory:") — CREATE TABLE IF NOT EXISTS is idempotent
    // Then:  no throw; tables present in second handle as well
    const db1 = openCredentialsDb(":memory:");
    db1.close();
    let db2: ReturnType<typeof openCredentialsDb> | undefined;
    assert.doesNotThrow(() => {
      db2 = openCredentialsDb(":memory:");
    }, "T-CRED.OPEN.2: second openCredentialsDb must not throw (idempotent schema migration)");
    const tables = (
      db2!.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[]
    ).map((r) => r.name);
    assert.ok(tables.includes("llm_keys"), "T-CRED.OPEN.2: llm_keys must exist in second open");
    db2!.close();
  });
});

// ─── T-CRED.LLM.1 ─────────────────────────────────────────────────────────────

describe("addLlmKey + getLlmKey: insert + retrieve (G-P28.15, G-P28.16)", () => {
  it("T-CRED.LLM.1: given :memory: db, addLlmKey with provider_type=anthropic, getLlmKey returns the row with matching fields", () => {
    // Given: empty credentials.sqlite (:memory:)
    // When:  addLlmKey(db, {id:'llm1', provider_type:'anthropic', base_url:null, api_key:'sk-PLACEHOLDER', label:'test'})
    //        getLlmKey(db, 'llm1')
    // Then:  returned row.api_key === 'sk-PLACEHOLDER'; row.provider_type === 'anthropic';
    //        row.assigned_count === 0; row.base_url === null
    const db = openCredentialsDb(":memory:");
    try {
      addLlmKey(db, {
        id: "llm1",
        provider_type: "anthropic",
        base_url: null,
        api_key: "sk-PLACEHOLDER",
        label: "test",
      });
      const row = getLlmKey(db, "llm1");
      assert.ok(row !== null, "T-CRED.LLM.1: getLlmKey must return a row after addLlmKey");
      assert.equal(row.api_key, "sk-PLACEHOLDER", "T-CRED.LLM.1: api_key must be 'sk-PLACEHOLDER' (C-5)");
      assert.equal(row.provider_type, "anthropic", "T-CRED.LLM.1: provider_type must be 'anthropic'");
      assert.equal(row.assigned_count, 0, "T-CRED.LLM.1: assigned_count must be 0 on insert");
      assert.equal(row.base_url, null, "T-CRED.LLM.1: base_url must be null");
    } finally {
      db.close();
    }
  });
});

// ─── T-CRED.LLM.2 ─────────────────────────────────────────────────────────────

describe("listLlmKeys: returns all rows (G-P28.16)", () => {
  it("T-CRED.LLM.2: given two llm_keys rows inserted, listLlmKeys returns array of length 2", () => {
    // Given: :memory: db; addLlmKey called twice with ids 'a' and 'b'
    // When:  listLlmKeys(db)
    // Then:  array.length === 2; both ids present
    const db = openCredentialsDb(":memory:");
    try {
      addLlmKey(db, { id: "a", provider_type: "anthropic", base_url: null, api_key: "sk-PLACEHOLDER", label: null });
      addLlmKey(db, { id: "b", provider_type: "openai", base_url: null, api_key: "sk-PLACEHOLDER", label: null });
      const rows = listLlmKeys(db);
      assert.equal(rows.length, 2, "T-CRED.LLM.2: listLlmKeys must return 2 rows (G-P28.16)");
      assert.ok(
        rows.some((r) => r.id === "a"),
        "T-CRED.LLM.2: rows must include id='a'",
      );
      assert.ok(
        rows.some((r) => r.id === "b"),
        "T-CRED.LLM.2: rows must include id='b'",
      );
    } finally {
      db.close();
    }
  });
});

// ─── T-CRED.LLM.3 ─────────────────────────────────────────────────────────────

describe("removeLlmKey: removes row, returns true; missing id returns false (G-P28.17)", () => {
  it("T-CRED.LLM.3: given llm_key row present, removeLlmKey returns true and row is gone; removeLlmKey for unknown id returns false", () => {
    // Given: :memory: db; 'llm1' row present
    // When:  removeLlmKey(db, 'llm1') → check; removeLlmKey(db, 'missing')
    // Then:  first call returns true; getLlmKey(db,'llm1') === null; second call returns false
    const db = openCredentialsDb(":memory:");
    try {
      addLlmKey(db, { id: "llm1", provider_type: "anthropic", base_url: null, api_key: "sk-PLACEHOLDER", label: null });
      const removed = removeLlmKey(db, "llm1");
      assert.equal(removed, true, "T-CRED.LLM.3: removeLlmKey must return true for existing row (G-P28.17)");
      assert.equal(getLlmKey(db, "llm1"), null, "T-CRED.LLM.3: getLlmKey must return null after removal");
      const missingRemove = removeLlmKey(db, "missing");
      assert.equal(missingRemove, false, "T-CRED.LLM.3: removeLlmKey must return false for unknown id (G-P28.17)");
    } finally {
      db.close();
    }
  });
});

// ─── T-CRED.LLM.4 ─────────────────────────────────────────────────────────────

describe("addLlmKey: duplicate id rejected (G-P28.18)", () => {
  it("T-CRED.LLM.4: given llm_key 'llm1' already exists, addLlmKey with same id throws UNIQUE constraint error", () => {
    // Given: :memory: db with row id='llm1' already inserted
    // When:  addLlmKey(db, {id:'llm1', ...}) — same id
    // Then:  throws Error (SQLite UNIQUE constraint violation); original row intact
    const db = openCredentialsDb(":memory:");
    try {
      addLlmKey(db, { id: "llm1", provider_type: "anthropic", base_url: null, api_key: "sk-PLACEHOLDER", label: null });
      assert.throws(() => {
        addLlmKey(db, { id: "llm1", provider_type: "openai", base_url: null, api_key: "sk-PLACEHOLDER", label: null });
      }, "T-CRED.LLM.4: duplicate id must throw UNIQUE constraint error (G-P28.18)");
      // Original row must still be present and intact
      const row = getLlmKey(db, "llm1");
      assert.ok(row !== null, "T-CRED.LLM.4: original row must be intact after failed duplicate insert");
      assert.equal(row.provider_type, "anthropic", "T-CRED.LLM.4: original row.provider_type must be unchanged");
    } finally {
      db.close();
    }
  });
});

// ─── T-CRED.LLM.5 ─────────────────────────────────────────────────────────────

describe("openai llmKey: base_url stored + retrieved (G-P28.15 openai variant)", () => {
  it("T-CRED.LLM.5: given addLlmKey with provider_type=openai + base_url set, getLlmKey returns matching base_url", () => {
    // Given: :memory: db
    // When:  addLlmKey(db, {id:'oai1', provider_type:'openai', base_url:'https://api.openai.com/v1', api_key:'sk-PLACEHOLDER', label:null})
    //        getLlmKey(db, 'oai1')
    // Then:  row.base_url === 'https://api.openai.com/v1'; row.provider_type === 'openai'
    const db = openCredentialsDb(":memory:");
    try {
      addLlmKey(db, {
        id: "oai1",
        provider_type: "openai",
        base_url: "https://api.openai.com/v1",
        api_key: "sk-PLACEHOLDER",
        label: null,
      });
      const row = getLlmKey(db, "oai1");
      assert.ok(row !== null, "T-CRED.LLM.5: getLlmKey must return a row");
      assert.equal(
        row.base_url,
        "https://api.openai.com/v1",
        "T-CRED.LLM.5: base_url must be stored and retrieved (G-P28.15)",
      );
      assert.equal(row.provider_type, "openai", "T-CRED.LLM.5: provider_type must be 'openai'");
    } finally {
      db.close();
    }
  });
});

// ─── T-CRED.GOOG.1 ────────────────────────────────────────────────────────────

describe("addGoogleAccount + listGoogleAccounts: insert + list (G-P28.19, G-P28.20)", () => {
  it("T-CRED.GOOG.1: given :memory: db, addGoogleAccount with all nullable fields null, listGoogleAccounts returns the row", () => {
    // Given: :memory: db
    // When:  addGoogleAccount(db, {id:'g1', email:'test@example.com', password:'PLACEHOLDER',
    //          recovery_email:null, phone:null, sms_link:null, twofa_link:null, label:null})
    //        listGoogleAccounts(db)
    // Then:  list.length === 1; list[0].email === 'test@example.com';
    //        list[0].twofa_link === null; list[0].assigned_count === 0
    const db = openCredentialsDb(":memory:");
    try {
      addGoogleAccount(db, {
        id: "g1",
        email: "test@example.com",
        password: "PLACEHOLDER",
        recovery_email: null,
        phone: null,
        sms_link: null,
        twofa_link: null,
        label: null,
      });
      const list = listGoogleAccounts(db);
      assert.equal(list.length, 1, "T-CRED.GOOG.1: listGoogleAccounts must return 1 row (G-P28.19 + G-P28.20)");
      assert.equal(list[0].email, "test@example.com", "T-CRED.GOOG.1: email must be 'test@example.com'");
      assert.equal(list[0].twofa_link, null, "T-CRED.GOOG.1: twofa_link must be null");
      assert.equal(list[0].assigned_count, 0, "T-CRED.GOOG.1: assigned_count must be 0 on insert");
    } finally {
      db.close();
    }
  });
});

// ─── T-CRED.GOOG.2 ────────────────────────────────────────────────────────────

describe("addGoogleAccount: optional P-28.5 fields stored (G-P28.19)", () => {
  it("T-CRED.GOOG.2: given addGoogleAccount with all P-28.5 nullable fields set, retrieved row has those fields intact", () => {
    // Given: :memory: db
    // When:  addGoogleAccount(db, {id:'g2', email:'full@example.com', password:'PLACEHOLDER',
    //          recovery_email:'rec@example.com', phone:'+1555000', sms_link:'https://sms.example.com/PLACEHOLDER',
    //          twofa_link:'https://2fa.show/PLACEHOLDER', label:'full-test'})
    //        listGoogleAccounts(db) → find row
    // Then:  row.recovery_email === 'rec@example.com'; row.twofa_link === 'https://2fa.show/PLACEHOLDER'
    const db = openCredentialsDb(":memory:");
    try {
      addGoogleAccount(db, {
        id: "g2",
        email: "full@example.com",
        password: "PLACEHOLDER",
        recovery_email: "rec@example.com",
        phone: "+1555000",
        sms_link: "https://sms.example.com/PLACEHOLDER",
        twofa_link: "https://2fa.show/PLACEHOLDER",
        label: "full-test",
      });
      const list = listGoogleAccounts(db);
      const row = list.find((r) => r.id === "g2");
      assert.ok(row !== undefined, "T-CRED.GOOG.2: row must be found after insert");
      assert.equal(row.recovery_email, "rec@example.com", "T-CRED.GOOG.2: recovery_email must be stored (G-P28.19)");
      assert.equal(
        row.twofa_link,
        "https://2fa.show/PLACEHOLDER",
        "T-CRED.GOOG.2: twofa_link must be stored (C-5 placeholder)",
      );
      assert.equal(row.label, "full-test", "T-CRED.GOOG.2: label must be stored");
    } finally {
      db.close();
    }
  });
});

// ─── T-CRED.GOOG.3 ────────────────────────────────────────────────────────────

describe("removeGoogleAccount: removes row, returns true (G-P28.21)", () => {
  it("T-CRED.GOOG.3: given google_account row present, removeGoogleAccount returns true and row is gone from list", () => {
    // Given: :memory: db; 'g1' row present
    // When:  removeGoogleAccount(db, 'g1')
    // Then:  returns true; listGoogleAccounts(db) returns []
    const db = openCredentialsDb(":memory:");
    try {
      addGoogleAccount(db, {
        id: "g1",
        email: "test@example.com",
        password: "PLACEHOLDER",
        recovery_email: null,
        phone: null,
        sms_link: null,
        twofa_link: null,
        label: null,
      });
      const removed = removeGoogleAccount(db, "g1");
      assert.equal(removed, true, "T-CRED.GOOG.3: removeGoogleAccount must return true for existing row (G-P28.21)");
      assert.equal(listGoogleAccounts(db).length, 0, "T-CRED.GOOG.3: listGoogleAccounts must return [] after removal");
    } finally {
      db.close();
    }
  });
});

// ─── T-CRED.GOOG.4 ────────────────────────────────────────────────────────────

describe("incrementLlmKeyAssignedCount + incrementGoogleAccountAssignedCount (G-P28.22)", () => {
  it("T-CRED.GOOG.4: given rows with assigned_count=0, incrementing twice yields assigned_count=2 for both llm and google rows", () => {
    // Given: :memory: db; llm_key 'llm1' + google_account 'g1' with assigned_count=0
    // When:  incrementLlmKeyAssignedCount(db,'llm1') ×2; incrementGoogleAccountAssignedCount(db,'g1') ×2
    // Then:  getLlmKey(db,'llm1').assigned_count === 2; listGoogleAccounts(db)[0].assigned_count === 2
    const db = openCredentialsDb(":memory:");
    try {
      addLlmKey(db, { id: "llm1", provider_type: "anthropic", base_url: null, api_key: "sk-PLACEHOLDER", label: null });
      addGoogleAccount(db, {
        id: "g1",
        email: "test@example.com",
        password: "PLACEHOLDER",
        recovery_email: null,
        phone: null,
        sms_link: null,
        twofa_link: null,
        label: null,
      });

      incrementLlmKeyAssignedCount(db, "llm1");
      incrementLlmKeyAssignedCount(db, "llm1");
      incrementGoogleAccountAssignedCount(db, "g1");
      incrementGoogleAccountAssignedCount(db, "g1");

      const llmRow = getLlmKey(db, "llm1");
      assert.equal(
        llmRow?.assigned_count,
        2,
        "T-CRED.GOOG.4: llm assigned_count must be 2 after 2 increments (G-P28.22)",
      );

      const googRows = listGoogleAccounts(db);
      assert.equal(
        googRows[0]?.assigned_count,
        2,
        "T-CRED.GOOG.4: google assigned_count must be 2 after 2 increments (G-P28.22)",
      );

      // Verify getGoogleAccount is also consistent
      const googRow = getGoogleAccount(db, "g1");
      assert.equal(googRow?.assigned_count, 2, "T-CRED.GOOG.4: getGoogleAccount assigned_count must also be 2");
    } finally {
      db.close();
    }
  });
});
