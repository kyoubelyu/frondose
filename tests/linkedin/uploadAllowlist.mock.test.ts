/**
 * P-3 mock tests — T-M41..T-M44: Upload path allowlist enforcement.
 *
 * Tests assertUploadPathAllowed() and resolveUploadAllowlist().
 * Per guardian critic CONCERN-MR-1 path (a): default is ~/.mai/agent/uploads (NOT
 * ~/Downloads, ~/Desktop, ~/Documents).
 *
 * No Chrome or LLM required.
 */

import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { assertUploadPathAllowed, resolveUploadAllowlist } from "../../src/linkedin/uploadAllowlist.js";

const HOME = os.homedir();
const DEFAULT_UPLOAD_DIR = path.join(HOME, ".frondose", "agent", "uploads");

// ─── T-M41 ─────────────────────────────────────────────────────────────────────

test("T-M41: resolveUploadAllowlist default is ~/.mai/agent/uploads (CONCERN-MR-1)", () => {
  // Clear env override for this test
  const prev = process.env.FRONDOSE_UPLOAD_ALLOWLIST;
  delete process.env.FRONDOSE_UPLOAD_ALLOWLIST;
  try {
    const allowlist = resolveUploadAllowlist();
    assert.equal(allowlist.length, 1, "default allowlist must have exactly 1 dir");
    assert.equal(allowlist[0], DEFAULT_UPLOAD_DIR, "default dir must be ~/.mai/agent/uploads");
  } finally {
    if (prev !== undefined) process.env.FRONDOSE_UPLOAD_ALLOWLIST = prev;
  }
});

// ─── T-M42 ─────────────────────────────────────────────────────────────────────

test("T-M42: assertUploadPathAllowed passes for paths inside the default upload dir", () => {
  const prev = process.env.FRONDOSE_UPLOAD_ALLOWLIST;
  delete process.env.FRONDOSE_UPLOAD_ALLOWLIST;
  try {
    // Path directly inside the allowlist dir must pass
    const allowed = path.join(DEFAULT_UPLOAD_DIR, "document.pdf");
    assert.doesNotThrow(() => assertUploadPathAllowed(allowed), "path inside ~/.mai/agent/uploads must not throw");

    // Nested subdir must also pass
    const nested = path.join(DEFAULT_UPLOAD_DIR, "batch", "image.png");
    assert.doesNotThrow(() => assertUploadPathAllowed(nested), "path in subdir of uploads must not throw");
  } finally {
    if (prev !== undefined) process.env.FRONDOSE_UPLOAD_ALLOWLIST = prev;
  }
});

// ─── T-M43 ─────────────────────────────────────────────────────────────────────

test("T-M43: assertUploadPathAllowed throws for paths outside the allowlist", () => {
  const prev = process.env.FRONDOSE_UPLOAD_ALLOWLIST;
  delete process.env.FRONDOSE_UPLOAD_ALLOWLIST;
  try {
    // Common sensitive dirs must NOT be in the default allowlist
    const outsidePaths = [
      path.join(HOME, "Downloads", "tax.pdf"),
      path.join(HOME, "Desktop", "photo.jpg"),
      path.join(HOME, "Documents", "contract.docx"),
      "/tmp/upload.png",
      "/etc/passwd",
    ];

    for (const p of outsidePaths) {
      assert.throws(
        () => assertUploadPathAllowed(p),
        /outside the allowed|outside the upload/i,
        `'${p}' must throw as it is outside the default allowlist`,
      );
    }
  } finally {
    if (prev !== undefined) process.env.FRONDOSE_UPLOAD_ALLOWLIST = prev;
  }
});

// ─── T-M44 ─────────────────────────────────────────────────────────────────────

test("T-M44: assertUploadPathAllowed blocks path traversal attacks (../)", () => {
  const prev = process.env.FRONDOSE_UPLOAD_ALLOWLIST;
  delete process.env.FRONDOSE_UPLOAD_ALLOWLIST;
  try {
    // Attempt to escape via ../ from inside the uploads dir
    const traversal = path.join(DEFAULT_UPLOAD_DIR, "..", "..", "agent", "identity.json");
    assert.throws(
      () => assertUploadPathAllowed(traversal),
      /outside the allowed/i,
      "../ traversal from within uploads dir must be blocked",
    );

    // Absolute path that looks like it's inside but isn't (after normalization)
    const fakeInside = `${DEFAULT_UPLOAD_DIR}/../../../etc/passwd`;
    assert.throws(
      () => assertUploadPathAllowed(fakeInside),
      /outside the allowed/i,
      "fakeInside traversal must be blocked by path.resolve canonicalization",
    );
  } finally {
    if (prev !== undefined) process.env.FRONDOSE_UPLOAD_ALLOWLIST = prev;
  }
});
