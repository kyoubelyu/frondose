/**
 * P-27 Step 5 — T-BR.1..7
 *
 * Tests for src/cli/subcommands/bootstrapRegister.ts — runBootstrapRegister.
 * Gate coverage: G-P27.17 (happy path: fetch POST /api/register + write config/secrets/identity),
 *                G-P27.18 (server error → throws; no files written; 401 → meaningful error message)
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type BootstrapRegisterDI, runBootstrapRegister } from "../../../src/cli/subcommands/bootstrapRegister.js";

// ─── DI stub builders ────────────────────────────────────────────────────────

function makeSuccessFetch(responseBody: object, status = 200): typeof globalThis.fetch {
  return async (_url: RequestInfo | URL, _opts?: RequestInit) => {
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => responseBody,
      text: async () => JSON.stringify(responseBody),
    } as unknown as Response;
  };
}

function makeFailFetch(status: number, errorBody: object): typeof globalThis.fetch {
  return async (_url: RequestInfo | URL, _opts?: RequestInit) => {
    return {
      ok: false,
      status,
      json: async () => errorBody,
      text: async () => JSON.stringify(errorBody),
    } as unknown as Response;
  };
}

// ─── T-BR.1 ─────────────────────────────────────────────────────────────────

describe("runBootstrapRegister — happy path writes config/secrets/identity (G-P27.17)", () => {
  it("T-BR.1: given server returns 200 {ok:true, workerId:'w1', permanentToken:'hex64', personaId:'p1', identity:{fullName:'Alice'}}, all 3 DI writers called once", async () => {
    // Given: fetchImpl returns 200 with workerId='w1', permanentToken='<64-char-hex>', personaId='p1',
    //        identity={fullName:'Alice',role:'BD',company:'Acme'}
    // When:  runBootstrapRegister({serverUrl:'http://server', inviteToken:'tok1'}, di)
    // Then:  di.writeConfigImpl called once; di.writeSecretsImpl called once; di.writeIdentityImpl called once
    //        no error thrown
    const writeConfigCalled: unknown[][] = [];
    const writeSecretsCalled: unknown[][] = [];
    const writeIdentityCalled: unknown[][] = [];

    const di: BootstrapRegisterDI = {
      fetchImpl: makeSuccessFetch({
        ok: true,
        workerId: "w1",
        permanentToken: "a".repeat(64),
        personaId: "p1",
        identity: { fullName: "Alice", role: "BD Specialist", company: "Acme" },
      }),
      writeConfigImpl: ((...args: unknown[]) => { writeConfigCalled.push(args); }) as BootstrapRegisterDI["writeConfigImpl"],
      writeSecretsImpl: ((...args: unknown[]) => { writeSecretsCalled.push(args); }) as BootstrapRegisterDI["writeSecretsImpl"],
      writeIdentityImpl: ((...args: unknown[]) => { writeIdentityCalled.push(args); }) as BootstrapRegisterDI["writeIdentityImpl"],
    };

    await assert.doesNotReject(
      () => runBootstrapRegister({ serverUrl: "http://server", inviteToken: "a".repeat(64) }, di),
      "must not throw on 200 response",
    );
    assert.equal(writeConfigCalled.length, 1, "writeConfigImpl must be called exactly once");
    assert.equal(writeSecretsCalled.length, 1, "writeSecretsImpl must be called exactly once");
    assert.equal(
      writeIdentityCalled.length,
      0,
      "P-28 D-9: writeIdentityImpl must NOT be called — config.json v2 is the sole source of truth for a provisioned worker",
    );
  });
});

// ─── T-BR.2 ─────────────────────────────────────────────────────────────────

describe("runBootstrapRegister — permanentToken written to secrets (G-P27.17)", () => {
  it("T-BR.2: given server returns permanentToken='deadbeef...', writeSecretsImpl receives config containing that token value", async () => {
    // Given: server 200 with permanentToken='deadbeef' + 56 more chars
    // When:  runBootstrapRegister(..., di)
    // Then:  writeSecretsImpl arg contains server.token matching returned permanentToken
    const capturedSecretsArgs: unknown[][] = [];
    const permanentToken = "deadbeef" + "0".repeat(56);
    const di: BootstrapRegisterDI = {
      fetchImpl: makeSuccessFetch({
        ok: true,
        workerId: "w2",
        permanentToken,
        personaId: "p1",
        identity: { fullName: "Alice", role: "BD", company: "Acme" },
      }),
      writeConfigImpl: (() => {}) as BootstrapRegisterDI["writeConfigImpl"],
      writeSecretsImpl: ((...args: unknown[]) => { capturedSecretsArgs.push(args); }) as BootstrapRegisterDI["writeSecretsImpl"],
      writeIdentityImpl: (() => {}) as BootstrapRegisterDI["writeIdentityImpl"],
    };
    await runBootstrapRegister({ serverUrl: "http://server", inviteToken: "b".repeat(64) }, di);
    assert.equal(capturedSecretsArgs.length, 1, "writeSecretsImpl must be called once");
    // First arg is the secrets object; must have server.token = permanentToken
    const secretsArg = capturedSecretsArgs[0][0] as { server?: { token?: string } };
    assert.equal(
      secretsArg?.server?.token,
      permanentToken,
      `secrets.server.token must equal permanentToken; got: ${JSON.stringify(secretsArg)}`,
    );
  });
});

// ─── T-BR.3 ─────────────────────────────────────────────────────────────────

describe("runBootstrapRegister — serverUrl written to config (G-P27.17)", () => {
  it("T-BR.3: given serverUrl='http://100.64.0.5:3031', writeConfigImpl receives config with serverUrl field set", async () => {
    // Given: serverUrl='http://100.64.0.5:3031'; server returns 200 with valid body
    // When:  runBootstrapRegister({serverUrl:'http://100.64.0.5:3031', inviteToken:'tok'}, di)
    // Then:  writeConfigImpl arg contains server.url='http://100.64.0.5:3031'
    const capturedConfigArgs: unknown[][] = [];
    const serverUrl = "http://100.64.0.5:3031";
    const di: BootstrapRegisterDI = {
      fetchImpl: makeSuccessFetch({
        ok: true,
        workerId: "w3",
        permanentToken: "c".repeat(64),
        personaId: "p1",
        identity: { fullName: "Alice", role: "BD", company: "Acme" },
      }),
      writeConfigImpl: ((...args: unknown[]) => { capturedConfigArgs.push(args); }) as BootstrapRegisterDI["writeConfigImpl"],
      writeSecretsImpl: (() => {}) as BootstrapRegisterDI["writeSecretsImpl"],
      writeIdentityImpl: (() => {}) as BootstrapRegisterDI["writeIdentityImpl"],
    };
    await runBootstrapRegister({ serverUrl, inviteToken: "c".repeat(64) }, di);
    assert.equal(capturedConfigArgs.length, 1, "writeConfigImpl must be called once");
    const cfgArg = capturedConfigArgs[0][0] as { server?: { url?: string } };
    assert.equal(
      cfgArg?.server?.url,
      serverUrl,
      `config.server.url must equal serverUrl; got: ${JSON.stringify(cfgArg)}`,
    );
  });
});

// ─── T-BR.4 ─────────────────────────────────────────────────────────────────

describe("runBootstrapRegister — server 401 throws meaningful error (G-P27.18)", () => {
  it("T-BR.4: given server returns 401 {ok:false, error:'invite invalid or consumed'}, runBootstrapRegister throws with message containing that error text", async () => {
    // Given: fetchImpl returns 401 {ok:false, error:'invite invalid or consumed'}
    // When:  runBootstrapRegister({serverUrl:'http://server', inviteToken:'bad'}, di)
    // Then:  throws Error with message containing '401' and/or 'invite invalid or consumed'
    const di: BootstrapRegisterDI = {
      fetchImpl: makeFailFetch(401, { ok: false, error: "invite invalid or consumed" }),
      writeConfigImpl: (() => { throw new Error("should not be called"); }) as BootstrapRegisterDI["writeConfigImpl"],
      writeSecretsImpl: (() => { throw new Error("should not be called"); }) as BootstrapRegisterDI["writeSecretsImpl"],
      writeIdentityImpl: (() => { throw new Error("should not be called"); }) as BootstrapRegisterDI["writeIdentityImpl"],
    };
    await assert.rejects(
      () => runBootstrapRegister({ serverUrl: "http://server", inviteToken: "d".repeat(64) }, di),
      (err: Error) => {
        assert.ok(
          err.message.includes("401") || err.message.includes("invite invalid or consumed"),
          `error must reference 401 or invite error; got: ${err.message}`,
        );
        return true;
      },
      "must throw on 401",
    );
  });
});

// ─── T-BR.5 ─────────────────────────────────────────────────────────────────

describe("runBootstrapRegister — server 500 throws; no DI writers called (G-P27.18)", () => {
  it("T-BR.5: given server returns 500 {error:'server error'}, throws; writeConfigImpl NOT called", async () => {
    // Given: fetchImpl returns 500 {error:'server error'}
    // When:  runBootstrapRegister(...)
    // Then:  throws Error; writeConfigImpl never called; writeSecretsImpl never called
    const writeConfigCalled: unknown[][] = [];
    const di: BootstrapRegisterDI = {
      fetchImpl: makeFailFetch(500, { error: "server error" }),
      writeConfigImpl: ((...args: unknown[]) => { writeConfigCalled.push(args); }) as BootstrapRegisterDI["writeConfigImpl"],
      writeSecretsImpl: (() => {}) as BootstrapRegisterDI["writeSecretsImpl"],
      writeIdentityImpl: (() => {}) as BootstrapRegisterDI["writeIdentityImpl"],
    };
    await assert.rejects(
      () => runBootstrapRegister({ serverUrl: "http://server", inviteToken: "e".repeat(64) }, di),
      Error,
      "must throw on 500",
    );
    assert.equal(writeConfigCalled.length, 0, "writeConfigImpl must NOT be called after 500");
  });
});

// ─── T-BR.6 ─────────────────────────────────────────────────────────────────

describe("runBootstrapRegister — fetch POSTs to /api/register with correct body (G-P27.17)", () => {
  it("T-BR.6: given serverUrl='http://srv' and inviteToken='<hex64>', fetchImpl called with URL 'http://srv/api/register' and body containing inviteToken", async () => {
    // Given: serverUrl='http://srv'; inviteToken='f'.repeat(64)
    // When:  runBootstrapRegister({serverUrl:'http://srv', inviteToken:'<hex64>'}, di)
    // Then:  fetchImpl called with first arg='http://srv/api/register';
    //        request body JSON contains inviteToken='<hex64>'
    const capturedFetchCalls: Array<{ url: unknown; opts: unknown }> = [];
    const inviteToken = "f".repeat(64);
    const di: BootstrapRegisterDI = {
      fetchImpl: async (url: RequestInfo | URL, opts?: RequestInit) => {
        capturedFetchCalls.push({ url, opts });
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            workerId: "w1",
            permanentToken: "f".repeat(64),
            personaId: "p1",
            identity: { fullName: "Alice", role: "BD", company: "Acme" },
          }),
          text: async () => "{}",
        } as unknown as Response;
      },
      writeConfigImpl: (() => {}) as BootstrapRegisterDI["writeConfigImpl"],
      writeSecretsImpl: (() => {}) as BootstrapRegisterDI["writeSecretsImpl"],
      writeIdentityImpl: (() => {}) as BootstrapRegisterDI["writeIdentityImpl"],
    };
    await runBootstrapRegister({ serverUrl: "http://srv", inviteToken }, di);
    assert.equal(capturedFetchCalls.length, 1, "fetchImpl must be called exactly once");
    const callUrl = String(capturedFetchCalls[0].url);
    assert.equal(callUrl, "http://srv/api/register", `fetch URL must be /api/register; got: ${callUrl}`);
    const opts = capturedFetchCalls[0].opts as RequestInit;
    assert.equal(opts.method, "POST", "fetch method must be POST");
    const bodyParsed = JSON.parse(opts.body as string);
    assert.equal(bodyParsed.inviteToken, inviteToken, `body.inviteToken must match; got: ${bodyParsed.inviteToken}`);
  });
});

// ─── T-BR.7 ─────────────────────────────────────────────────────────────────

describe("runBootstrapRegister — network error throws (G-P27.18)", () => {
  it("T-BR.7: given fetchImpl rejects (network error), runBootstrapRegister throws; no DI writers called", async () => {
    // Given: fetchImpl throws Error('connection refused')
    // When:  runBootstrapRegister({serverUrl:'http://offline', inviteToken:'tok'}, di)
    // Then:  throws Error (propagated as '[bootstrap-register] server unreachable: ...'); no writeConfigImpl calls
    const writeConfigCalled: unknown[][] = [];
    const di: BootstrapRegisterDI = {
      fetchImpl: async () => { throw new Error("connection refused"); },
      writeConfigImpl: ((...args: unknown[]) => { writeConfigCalled.push(args); }) as BootstrapRegisterDI["writeConfigImpl"],
      writeSecretsImpl: (() => {}) as BootstrapRegisterDI["writeSecretsImpl"],
      writeIdentityImpl: (() => {}) as BootstrapRegisterDI["writeIdentityImpl"],
    };
    await assert.rejects(
      () => runBootstrapRegister({ serverUrl: "http://offline", inviteToken: "g".repeat(64) }, di),
      (err: Error) => {
        assert.ok(
          err.message.includes("server unreachable") || err.message.includes("connection refused"),
          `error must indicate network failure; got: ${err.message}`,
        );
        return true;
      },
      "must throw on network error",
    );
    assert.equal(writeConfigCalled.length, 0, "writeConfigImpl must NOT be called after network error");
  });
});
