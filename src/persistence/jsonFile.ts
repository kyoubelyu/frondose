/** Shared BOM-tolerant JSON file read helper (ISSUE-CONFIG-BOM-STRIP).
 *
 * `readFileSync(path, "utf-8")` decodes a leading UTF-8 BOM (EF BB BF) into
 * the `﻿` character but does not strip it, so `JSON.parse` throws on
 * any file hand-edited on Windows via PowerShell Out-File/Set-Content/`>`
 * or legacy Notepad (both commonly emit a BOM). Every persistence reader
 * routes its raw read+parse through this helper instead of inlining
 * `JSON.parse(readFileSync(...))`.
 */
import { readFileSync } from "node:fs";

const BOM = "﻿";

export function readJsonFileSync(path: string): unknown {
  const text = readFileSync(path, "utf-8");
  return JSON.parse(text.startsWith(BOM) ? text.slice(BOM.length) : text);
}
