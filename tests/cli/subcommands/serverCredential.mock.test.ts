/**
 * P-28 Step 4a — T-CLI.LLM.ADD.1..2, T-CLI.LLM.LIST.1, T-CLI.LLM.REMOVE.1,
 *                 T-CLI.GOOG.ADD.1, T-CLI.GOOG.LIST.1
 *
 * Tests for runServerCredentialSubcommand() in src/cli/subcommands/serverCredential.ts.
 * Gate coverage: G-P28.33 (llm-key add stores row), G-P28.34 (llm-key list outputs rows),
 *                G-P28.35 (llm-key remove deletes row), G-P28.36 (google-account add stores),
 *                G-P28.37 (google-account list outputs rows)
 *
 * Uses B-2 DI (_openDb injection) to share a single `:memory:` handle per test.
 * The inject closure returns the pre-opened handle ignoring the path argument so
 * each test's state survives across multiple runServerCredentialSubcommand calls.
 *
 * CREDENTIAL PLACEHOLDER POLICY (C-5): All fixtures use obvious placeholders ONLY.
 *   api_key    → "sk-PLACEHOLDER"
 *   password   → "PLACEHOLDER"
 *   twofa_link → "https://2fa.show/PLACEHOLDER"
 * NEVER a real API key, real password, or live SMS/2FA URL.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runServerCredentialSubcommand } from "../../../src/cli/subcommands/serverCredential.js";
import {
  addGoogleAccount,
  addLlmKey,
  listGoogleAccounts,
  listLlmKeys,
  openCredentialsDb,
} from "../../../src/persistence/credentialLibrary.js";

// ─── T-CLI.LLM.ADD.1 ──────────────────────────────────────────────────────────

describe("runServerCredentialSubcommand llm-key add: stores row in DB (G-P28.33)", () => {
  it("T-CLI.LLM.ADD.1: given empty :memory: DB, llm-key add with anthropic type stores a row retrievable via listLlmKeys", async () => {
    // Given: :memory: credentials DB; no existing rows
    // When:  runServerCredentialSubcommand('llm-key', 'add',
    //          {id:'llm1', type:'anthropic', key:'sk-PLACEHOLDER', label:'test'}, inject)
    // Then:  listLlmKeys(db).length === 1; row.api_key === 'sk-PLACEHOLDER'; no throw
    const db = openCredentialsDb(":memory:");
    const inject = (_path: string) => db;
    try {
      await assert.doesNotReject(
        () =>
          runServerCredentialSubcommand(
            "llm-key",
            "add",
            {
              id: "llm1",
              type: "anthropic",
              key: "sk-PLACEHOLDER",
              label: "test",
            },
            inject,
          ),
        "T-CLI.LLM.ADD.1: llm-key add must not throw",
      );
      const rows = listLlmKeys(db);
      assert.equal(rows.length, 1, "T-CLI.LLM.ADD.1: must have 1 row after add (G-P28.33)");
      assert.equal(rows[0].api_key, "sk-PLACEHOLDER", "T-CLI.LLM.ADD.1: api_key must be 'sk-PLACEHOLDER' (C-5)");
      assert.equal(rows[0].provider_type, "anthropic", "T-CLI.LLM.ADD.1: provider_type must be 'anthropic'");
      assert.equal(rows[0].label, "test", "T-CLI.LLM.ADD.1: label must be 'test'");
    } finally {
      db.close();
    }
  });
});

// ─── T-CLI.LLM.ADD.2 ──────────────────────────────────────────────────────────

describe("runServerCredentialSubcommand llm-key add: openai with base_url (G-P28.33)", () => {
  it("T-CLI.LLM.ADD.2: given empty :memory: DB, llm-key add with openai type + baseUrl stores row with base_url set", async () => {
    // Given: :memory: credentials DB
    // When:  runServerCredentialSubcommand('llm-key', 'add',
    //          {id:'oai1', type:'openai', baseUrl:'https://api.openai.com/v1', key:'sk-PLACEHOLDER'}, inject)
    // Then:  listLlmKeys(db)[0].base_url === 'https://api.openai.com/v1'
    const db = openCredentialsDb(":memory:");
    const inject = (_path: string) => db;
    try {
      await runServerCredentialSubcommand(
        "llm-key",
        "add",
        {
          id: "oai1",
          type: "openai",
          baseUrl: "https://api.openai.com/v1",
          key: "sk-PLACEHOLDER",
        },
        inject,
      );
      const rows = listLlmKeys(db);
      assert.equal(rows.length, 1, "T-CLI.LLM.ADD.2: must have 1 row after add");
      assert.equal(
        rows[0].base_url,
        "https://api.openai.com/v1",
        "T-CLI.LLM.ADD.2: base_url must be stored (G-P28.33)",
      );
      assert.equal(rows[0].provider_type, "openai", "T-CLI.LLM.ADD.2: provider_type must be 'openai'");
    } finally {
      db.close();
    }
  });
});

// ─── T-CLI.LLM.LIST.1 ─────────────────────────────────────────────────────────

describe("runServerCredentialSubcommand llm-key list: outputs table (G-P28.34)", () => {
  it("T-CLI.LLM.LIST.1: given two llm_key rows, llm-key list completes without throw (output to stdout captured or ignored)", async () => {
    // Given: :memory: DB with two llm_key rows
    // When:  runServerCredentialSubcommand('llm-key', 'list', {json:false}, inject)
    // Then:  resolves without throw (list is printed to stdout — not asserted in mock)
    const db = openCredentialsDb(":memory:");
    const inject = (_path: string) => db;
    try {
      addLlmKey(db, { id: "a", provider_type: "anthropic", base_url: null, api_key: "sk-PLACEHOLDER", label: null });
      addLlmKey(db, { id: "b", provider_type: "openai", base_url: null, api_key: "sk-PLACEHOLDER", label: null });
      await assert.doesNotReject(
        () => runServerCredentialSubcommand("llm-key", "list", { json: false }, inject),
        "T-CLI.LLM.LIST.1: llm-key list must not throw (G-P28.34)",
      );
    } finally {
      db.close();
    }
  });
});

// ─── T-CLI.LLM.REMOVE.1 ───────────────────────────────────────────────────────

describe("runServerCredentialSubcommand llm-key remove: deletes row (G-P28.35)", () => {
  it("T-CLI.LLM.REMOVE.1: given existing llm_key row 'llm1', llm-key remove deletes it — subsequent listLlmKeys returns []", async () => {
    // Given: :memory: DB with row id='llm1' (api_key='sk-PLACEHOLDER')
    // When:  runServerCredentialSubcommand('llm-key', 'remove', {id:'llm1'}, inject)
    // Then:  listLlmKeys(db) === []; no throw
    const db = openCredentialsDb(":memory:");
    const inject = (_path: string) => db;
    try {
      addLlmKey(db, { id: "llm1", provider_type: "anthropic", base_url: null, api_key: "sk-PLACEHOLDER", label: null });
      await assert.doesNotReject(
        () => runServerCredentialSubcommand("llm-key", "remove", { id: "llm1" }, inject),
        "T-CLI.LLM.REMOVE.1: llm-key remove must not throw",
      );
      const rows = listLlmKeys(db);
      assert.equal(rows.length, 0, "T-CLI.LLM.REMOVE.1: listLlmKeys must return [] after removal (G-P28.35)");
    } finally {
      db.close();
    }
  });
});

// ─── T-CLI.GOOG.ADD.1 ─────────────────────────────────────────────────────────

describe("runServerCredentialSubcommand google-account add: stores row (G-P28.36)", () => {
  it("T-CLI.GOOG.ADD.1: given empty :memory: DB, google-account add stores row with all P-28.5 nullable fields", async () => {
    // Given: :memory: credentials DB
    // When:  runServerCredentialSubcommand('google-account', 'add',
    //          {id:'g1', email:'test@example.com', password:'PLACEHOLDER',
    //           twofaLink:'https://2fa.show/PLACEHOLDER'}, inject)
    // Then:  listGoogleAccounts(db).length === 1;
    //        row.twofa_link === 'https://2fa.show/PLACEHOLDER'; no throw
    const db = openCredentialsDb(":memory:");
    const inject = (_path: string) => db;
    try {
      await assert.doesNotReject(
        () =>
          runServerCredentialSubcommand(
            "google-account",
            "add",
            {
              id: "g1",
              email: "test@example.com",
              password: "PLACEHOLDER",
              twofaLink: "https://2fa.show/PLACEHOLDER",
            },
            inject,
          ),
        "T-CLI.GOOG.ADD.1: google-account add must not throw",
      );
      const rows = listGoogleAccounts(db);
      assert.equal(rows.length, 1, "T-CLI.GOOG.ADD.1: must have 1 row after google-account add (G-P28.36)");
      assert.equal(
        rows[0].twofa_link,
        "https://2fa.show/PLACEHOLDER",
        "T-CLI.GOOG.ADD.1: twofa_link must be stored (C-5 placeholder)",
      );
      assert.equal(rows[0].email, "test@example.com", "T-CLI.GOOG.ADD.1: email must be 'test@example.com'");
    } finally {
      db.close();
    }
  });
});

// ─── T-CLI.GOOG.LIST.1 ────────────────────────────────────────────────────────

describe("runServerCredentialSubcommand google-account list: outputs table (G-P28.37)", () => {
  it("T-CLI.GOOG.LIST.1: given two google_account rows, google-account list completes without throw", async () => {
    // Given: :memory: DB with two google_account rows
    // When:  runServerCredentialSubcommand('google-account', 'list', {json:false}, inject)
    // Then:  resolves without throw
    const db = openCredentialsDb(":memory:");
    const inject = (_path: string) => db;
    try {
      addGoogleAccount(db, {
        id: "g1",
        email: "alice@example.com",
        password: "PLACEHOLDER",
        recovery_email: null,
        phone: null,
        sms_link: null,
        twofa_link: null,
        label: null,
      });
      addGoogleAccount(db, {
        id: "g2",
        email: "bob@example.com",
        password: "PLACEHOLDER",
        recovery_email: null,
        phone: null,
        sms_link: null,
        twofa_link: null,
        label: null,
      });
      await assert.doesNotReject(
        () => runServerCredentialSubcommand("google-account", "list", { json: false }, inject),
        "T-CLI.GOOG.LIST.1: google-account list must not throw (G-P28.37)",
      );
    } finally {
      db.close();
    }
  });
});
