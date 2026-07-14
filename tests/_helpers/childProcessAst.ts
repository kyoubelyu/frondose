/**
 * P-FIX-NOBASH-DETECTOR — shared TS-AST no-bash detector.
 *
 * Replaces the raw `content.includes("child_process")` substring scan used
 * by eight call sites across the repo, all of which false-positive on
 * src/tools/browser/scopedResolve.ts:5's comment documenting the ABSENCE of
 * child_process (see docs/phase-fix-nobash-detector-plan.md §1 for the list).
 *
 * AST-based classification (not lexical) is the PRECISE layer: a comment
 * that merely contains the substring "child_process" is inert to it (the
 * original `scopedResolve.ts:5` defect this phase exists to fix). A SECOND,
 * independent floor-guarantee layer (plan §3f, below) is deliberately
 * blunter: it exempts ONLY comments, not other non-comment string literals
 * that happen to mention "child_process" (e.g. an error message) — see
 * `self.23` in `tests/contract/noBashDetector.mock.test.ts` for the pinned,
 * accepted behavior this produces. Same-file, syntactic/structural
 * analysis (see plan §3b for the explicit, declared scope boundary):
 * catches static imports (incl. `node:` prefix and side-effect-only
 * `import "child_process"`), re-export chains, `import = require(...)`,
 * `require("child_process")`, dynamic `import("child_process")`,
 * string-concatenation and template-literal obfuscation via constant-
 * folding, wrapped/aliased require callees (parenthesized, `as`-cast,
 * `module.require`, `process.getBuiltinModule`, bracket-notation,
 * `.call`/`.apply`, chained IIFE, transitive `createRequire(...)` aliases,
 * same-file pass-through wrapper functions), `Function`/`eval`/`globalThis.*`/
 * comma-expression indirection (string arguments recursively re-scanned),
 * and same-file nearest-enclosing-SCOPE `const`-string variable resolution
 * that correctly stops at any non-const shadow (parameter, `let`, `var`,
 * destructured, catch-bound) rather than reading through it to an unrelated
 * outer `const` (round-3 BLOCKER 1 — NOT a flat file-wide map, which was
 * scope-unsound; see plan §3b/§3c). Any require()/dynamic-import()-like
 * call whose argument cannot be statically proven safe is FAIL-CLOSED
 * (flagged) rather than silently passed.
 *
 * Explicit, declared scope boundary (plan §3b, endorsed by the round-3
 * critic as "correctly drawn"): same-file syntactic analysis only. Does
 * NOT perform cross-file/cross-module points-to analysis, Proxy/getter/
 * setter trap analysis, or prototype/global monkey-patching detection —
 * these require a whole-program taint-analysis engine, disproportionate
 * for a single-file AST lint backing up the CI-enforced Biome
 * `noRestrictedImports` rule (biome.json), which is equally incapable of
 * catching those exotic forms and remains the load-bearing gate for the
 * boundary generally.
 *
 * Shape follows the established precedent in
 * tests/meta/identity-config-isolation-lint.test.ts
 * (findIdentityIsolationViolations): visitor pattern, line numbers via
 * getLineAndCharacterOfPosition, truncated callText.
 */

import ts from "typescript";

export type ChildProcessViolationKind =
  | "import"
  | "export-from"
  | "import-equals require"
  | "require()-like"
  | "dynamic import()"
  | "dynamic code (eval/Function)"
  | "opaque require()/import()-like call"
  | "substring-scan floor guarantee";

export interface ChildProcessViolation {
  file: string;
  line: number;
  kind: ChildProcessViolationKind;
  /** The resolved forbidden specifier, or null for the fail-closed "opaque" kind. */
  specifier: string | null;
  callText: string;
}

const FORBIDDEN_SPECIFIERS = new Set(["child_process", "node:child_process"]);

/**
 * FLOOR-GUARANTEE LAYER (Step-6 round-3 convergence ruling — plan §3f).
 *
 * Three successive audit rounds each found one more same-file invocation-
 * indirection form the classification-based AST layer above missed
 * (`.call`/`.apply` → `.bind` → `Reflect.apply`/`Reflect.construct`), and
 * that family has no natural end (any callable-indirection API can be the
 * next member). Rather than continuing to enumerate forms, this layer
 * makes the non-looseness guarantee hold BY CONSTRUCTION: it blanks out
 * exactly the lexical comment ranges of the source, then runs the OLD
 * `content.includes("child_process")` check on what's left. This is
 * provably a superset of the old detector's true-positive behavior —
 * identical except for excluding comments, which is the one class of
 * false positive this whole phase exists to fix (the `scopedResolve.ts:5`
 * defect). It therefore catches `.call`/`.apply`/`.bind`/`Reflect.*`/any
 * future member of the same family automatically, with no per-form
 * enumeration.
 *
 * Comment ranges are collected by walking the PARSED tree, NOT a raw
 * `ts.createScanner` token scan. A raw scanner cannot correctly resume
 * scanning inside a template-literal substitution (`` `...${expr}...` ``)
 * without a parser driving `reScanTemplateToken()` at each `${`/`}`
 * boundary — verified directly: a bare `.scan()` loop over
 * `` `https://x/${token}` `` misread the closing backtick after the `}` as
 * the START of a brand-new, unterminated template literal and silently
 * swallowed the ENTIRE REST OF THE FILE as "template content," never
 * emitting a single comment token again. This caused a real, second false
 * positive on `src/tools/operatorOutput/telegram.ts` (a template literal
 * earlier in the file desynced the raw scanner; its JSDoc further down,
 * containing `` `child_process` `` in backticks, was never recognized as a
 * comment) — caught only by running the layer against the live repo tree
 * before shipping.
 *
 * Two calls per position — `ts.getLeadingCommentRanges` AND
 * `ts.getTrailingCommentRanges` — are required, not one. Per the
 * TypeScript source (`iterateCommentRanges`/`getCommentRanges` in
 * `typescript.js`), leading mode only starts collecting AFTER the scan
 * crosses a line break (or at `pos === 0`) — it structurally cannot see a
 * same-line, inline comment between two tokens (`const /* c *\/ x`).
 * Trailing mode starts collecting immediately (no line-break needed) but
 * stops at the first line break — the complementary case.
 *
 * **The positions checked must be every TOKEN's `getFullStart()`, not
 * every AST NODE's.** `ts.forEachChild` (the earlier approach) only
 * visits semantically-significant children and skips PUNCTUATION tokens
 * (`(`, `)`, `{`, `}`, `[`, `]`) entirely — so a comment as the sole
 * content of an empty container (`{ /* c *\/ }`, `[/* c *\/]`, an empty
 * call-argument list, the gap between a function name and its parameter
 * list) has no visited node positioned after it to attach to, and was
 * missed. The fix: walk the CONCRETE syntax tree via `node.getChildren(sourceFile)`
 * (which, unlike `forEachChild`, yields every token including
 * punctuation) down to each LEAF token, and probe there. This is
 * complete by the lexer's own invariant — every comment is leading
 * trivia of exactly one following token (or of the `EndOfFileToken` if
 * nothing follows) — so enumerating every token exhausts every position a
 * comment could attach to. (This also makes the earlier `JsxExpression`
 * special case unnecessary: its `{`/`}` punctuation tokens are ordinary
 * leaves in the concrete tree and get probed like any other token.)
 * Verified against 15 adversarial probes (inline/trailing/EOF/JSX/
 * function-param-gap/empty-block/empty-call-args/empty-array/empty-class-
 * body/switch-case/nested-JSX/leading-whitespace) plus the real
 * `telegram.ts` file — all pass.
 */
function stripComments(sourceFile: ts.SourceFile): string {
  const fullText = sourceFile.getFullText();
  const chars = fullText.split("");
  const seen = new Set<string>();

  function blank(range: ts.CommentRange): void {
    const key = `${range.pos}-${range.end}`;
    if (seen.has(key)) return;
    seen.add(key);
    for (let i = range.pos; i < range.end; i++) {
      if (chars[i] !== "\n") chars[i] = " "; // preserve newlines so line numbers stay accurate
    }
  }

  function collect(pos: number): void {
    for (const r of ts.getLeadingCommentRanges(fullText, pos) ?? []) blank(r);
    for (const r of ts.getTrailingCommentRanges(fullText, pos) ?? []) blank(r);
  }

  function visit(node: ts.Node): void {
    const children = node.getChildren(sourceFile);
    if (children.length === 0) {
      collect(node.getFullStart()); // leaf token — the position to probe
    } else {
      for (const child of children) visit(child);
    }
  }
  visit(sourceFile);
  collect(sourceFile.endOfFileToken.getFullStart()); // belt-and-suspenders; already reached as a leaf above

  return chars.join("");
}

/** Index of "child_process" in the comment-stripped source, or -1 if absent. */
function forbiddenSubstringIndexOutsideComments(sourceFile: ts.SourceFile): number {
  return stripComments(sourceFile).indexOf("child_process");
}

/** Strips transparent wrappers (parens, `as`, `!`, `satisfies`, comma-expressions) around an expression. */
function unwrapExpr(e: ts.Expression): ts.Expression {
  while (true) {
    if (ts.isParenthesizedExpression(e)) {
      e = e.expression;
      continue;
    }
    if (ts.isAsExpression(e)) {
      e = e.expression;
      continue;
    }
    if (ts.isNonNullExpression(e)) {
      e = e.expression;
      continue;
    }
    if (ts.isSatisfiesExpression(e)) {
      e = e.expression;
      continue;
    }
    // comma-expression: (0, eval) — take the rightmost operand
    if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.CommaToken) {
      e = e.right;
      continue;
    }
    break;
  }
  return e;
}

function enclosingScope(node: ts.Node): ts.Node | undefined {
  let p: ts.Node | undefined = node.parent;
  while (p) {
    if (ts.isBlock(p) || ts.isSourceFile(p) || ts.isModuleBlock(p) || ts.isCaseClause(p) || ts.isDefaultClause(p)) {
      return p;
    }
    p = p.parent;
  }
  return undefined;
}

/** The function-like node (if any) whose parameter list directly encloses `scope`. */
function enclosingFunctionLike(scope: ts.Node): ts.SignatureDeclaration | undefined {
  const p = scope.parent;
  if (!p) return undefined;
  if (
    ts.isFunctionDeclaration(p) ||
    ts.isFunctionExpression(p) ||
    ts.isArrowFunction(p) ||
    ts.isMethodDeclaration(p) ||
    ts.isConstructorDeclaration(p) ||
    ts.isGetAccessorDeclaration(p) ||
    ts.isSetAccessorDeclaration(p)
  ) {
    return p;
  }
  return undefined;
}

function statementsOf(scope: ts.Node): readonly ts.Statement[] {
  if (ts.isSourceFile(scope)) return scope.statements;
  if (ts.isBlock(scope) || ts.isModuleBlock(scope)) return scope.statements;
  if (ts.isCaseClause(scope) || ts.isDefaultClause(scope)) return scope.statements;
  return [];
}

function isConstList(list: ts.VariableDeclarationList): boolean {
  return (list.flags & ts.NodeFlags.Const) !== 0;
}

/** Does any binding form (name) in this pattern match `name`? Handles nested destructuring. */
function bindingNamesInclude(pattern: ts.BindingName, name: string): boolean {
  if (ts.isIdentifier(pattern)) return pattern.text === name;
  for (const el of pattern.elements) {
    if (ts.isBindingElement(el) && bindingNamesInclude(el.name, name)) return true;
  }
  return false;
}

interface ResolveCtx {
  createRequireLocalName: string;
  requireAliases: Set<string>;
  wrapperNames: Set<string>;
  fileName: string;
}

/**
 * Resolves an identifier to a constant string by walking OUTWARD through
 * enclosing lexical scopes (innermost first). At each scope, first checks
 * whether the identifier's OWN enclosing function has a parameter of the
 * same name (a non-const shadow barrier — round-3 BLOCKER 1), then searches
 * that scope's own statement list for a matching `const` declaration
 * (resolved if foldable), then any matching non-const/destructured
 * declaration (a shadow barrier that also stops resolution). This
 * correctly refuses to "see through" a same-named non-const shadow to an
 * unrelated outer `const` — the bug a flat file-wide map (or a const-only
 * scope walk that skips non-const shadows) would have.
 */
function resolveIdentifierToConstString(id: ts.Identifier, ctx: ResolveCtx): string | null {
  let scope = enclosingScope(id);
  while (scope) {
    const fn = enclosingFunctionLike(scope);
    if (fn?.parameters.some((p) => bindingNamesInclude(p.name, id.text))) {
      return null; // shadowed by a parameter — cannot fold, do not continue outward
    }
    for (const stmt of statementsOf(scope)) {
      if (!ts.isVariableStatement(stmt)) continue;
      for (const decl of stmt.declarationList.declarations) {
        if (!bindingNamesInclude(decl.name, id.text)) continue;
        if (isConstList(stmt.declarationList) && ts.isIdentifier(decl.name) && decl.initializer) {
          return foldConstantString(decl.initializer, ctx);
        }
        return null; // non-const (or destructured) shadow of the same name — stop, cannot fold
      }
    }
    scope = scope.parent ? enclosingScope(scope) : undefined;
  }
  return null;
}

/**
 * Constant-folds StringLiteralLike, binary `+` chains, TemplateExpression
 * (head + recursively-folded spans), and identifiers resolved through
 * scope-aware `const`-binding lookup. Null if not statically foldable
 * (TaggedTemplateExpression, PropertyAccess, non-const identifiers, etc. —
 * intentionally never folded).
 */
function foldConstantString(expr: ts.Expression, ctx: ResolveCtx): string | null {
  const e = unwrapExpr(expr);
  if (ts.isStringLiteralLike(e)) return e.text;
  if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = foldConstantString(e.left, ctx);
    const right = foldConstantString(e.right, ctx);
    return left !== null && right !== null ? left + right : null;
  }
  if (ts.isTemplateExpression(e)) {
    let result = e.head.text;
    for (const span of e.templateSpans) {
      const sub = foldConstantString(span.expression, ctx);
      if (sub === null) return null;
      result += sub + span.literal.text;
    }
    return result;
  }
  if (ts.isIdentifier(e)) return resolveIdentifierToConstString(e, ctx);
  return null;
}

function isCreateRequireCall(expr: ts.Expression, ctx: ResolveCtx): expr is ts.CallExpression {
  const e = unwrapExpr(expr);
  return (
    ts.isCallExpression(e) &&
    ts.isIdentifier(unwrapExpr(e.expression)) &&
    (unwrapExpr(e.expression) as ts.Identifier).text === ctx.createRequireLocalName
  );
}

function isGlobalThisDot(expr: ts.Expression, name: string): boolean {
  return (
    ts.isPropertyAccessExpression(expr) &&
    ts.isIdentifier(expr.expression) &&
    expr.expression.text === "globalThis" &&
    expr.name.text === name
  );
}

/**
 * Extracts a member access's name + receiver, whether written as dot
 * notation (`X.name`) or bracket notation with a foldable key (`X["name"]`).
 * Unifying these two AST shapes closes the audit BLOCKER where
 * `require["call"](...)`/`require["apply"](...)` bypassed `.call`/`.apply`
 * recognition (previously dot-notation-only).
 */
function memberAccessName(callee: ts.Expression, ctx: ResolveCtx): { name: string; receiver: ts.Expression } | null {
  if (ts.isPropertyAccessExpression(callee)) return { name: callee.name.text, receiver: callee.expression };
  if (ts.isElementAccessExpression(callee)) {
    const key = foldConstantString(callee.argumentExpression, ctx);
    if (key !== null) return { name: key, receiver: callee.expression };
  }
  return null;
}

/**
 * If `expr` (after unwrap) is itself a CallExpression whose own callee is a
 * `.bind` member access (dot or bracket) on a require-like receiver —
 * e.g. `require["bind"](null)` inside `require["bind"](null)("child_process")`
 * — returns that inner `.bind(...)` CallExpression node (so its own
 * arguments can be inspected for a pre-bound module name). Null otherwise.
 * Round-6-audit BLOCKER: `.bind` was the one require-like indirection form
 * `.call`/`.apply` handling didn't cover.
 */
function isBoundRequireCallExpr(expr: ts.Expression, ctx: ResolveCtx): ts.CallExpression | null {
  const e = unwrapExpr(expr);
  if (!ts.isCallExpression(e)) return null;
  const member = memberAccessName(unwrapExpr(e.expression), ctx);
  if (member && member.name === "bind" && isRequireLikeCallee(member.receiver, ctx)) return e;
  return null;
}

/** Require-like callees: identifier `require`/tracked aliases, `.require`/`.getBuiltinModule`
 * member access (dot or bracket), `.call`/`.apply`/`.bind` (dot or bracket) on a require-like
 * receiver, and chained `createRequire(...)()`. */
function isRequireLikeCallee(calleeRaw: ts.Expression, ctx: ResolveCtx): boolean {
  const callee = unwrapExpr(calleeRaw);
  if (ts.isIdentifier(callee)) {
    return callee.text === "require" || ctx.requireAliases.has(callee.text) || ctx.wrapperNames.has(callee.text);
  }
  const member = memberAccessName(callee, ctx);
  if (member) {
    if (member.name === "require") return true; // module.require(...), X.require(...), X["require"](...)
    if (member.name === "getBuiltinModule") return true; // process.getBuiltinModule(...)
    if ((member.name === "call" || member.name === "apply") && isRequireLikeCallee(member.receiver, ctx)) {
      return true;
    }
  }
  if (isCreateRequireCall(callee, ctx)) return true; // createRequire(...)(...)
  if (isBoundRequireCallExpr(callee, ctx) !== null) return true; // require["bind"](thisArg)(...) / require.bind(thisArg)(...)
  return false;
}

function isEvalLikeCallee(calleeRaw: ts.Expression): boolean {
  const callee = unwrapExpr(calleeRaw);
  if (ts.isIdentifier(callee)) return callee.text === "Function" || callee.text === "eval";
  return isGlobalThisDot(callee, "Function") || isGlobalThisDot(callee, "eval");
}

/** For X.call(thisArg, arg) / X.apply(thisArg, [arg]) / X.bind(thisArg[, arg])(...) —
 * dot OR bracket notation — extracts the "module name" argument node. For `.bind`, a
 * pre-bound module argument (bind's own 2nd argument) wins if present; otherwise null
 * is returned so the caller falls through to the outer call's own first argument
 * (the bound function's argument at call time). */
function moduleArgFromCallOrApply(node: ts.CallExpression, ctx: ResolveCtx): ts.Expression | null {
  const callee = unwrapExpr(node.expression);
  const bindCall = isBoundRequireCallExpr(callee, ctx);
  if (bindCall) {
    return bindCall.arguments.length >= 2 ? bindCall.arguments[1] : null;
  }
  const member = memberAccessName(callee, ctx);
  if (!member) return null;
  if (member.name === "call" && node.arguments.length >= 2) return node.arguments[1];
  if (member.name === "apply" && node.arguments.length >= 2) {
    const arr = unwrapExpr(node.arguments[1]);
    if (ts.isArrayLiteralExpression(arr) && arr.elements.length >= 1) return arr.elements[0];
  }
  return null;
}

/**
 * AST-walks one TS/JS source and returns every static/dynamic/require/
 * re-export reference to a forbidden module specifier (child_process /
 * node:child_process), plus any require()/dynamic-import()/eval-like call
 * whose argument cannot be proven safe (fail-closed — see module docstring
 * for the full design and the explicit scope boundary).
 */
export function findChildProcessImports(fileName: string, sourceText: string): ChildProcessViolation[] {
  const sf = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true);
  const violations: ChildProcessViolation[] = [];
  const ctx: ResolveCtx = {
    createRequireLocalName: "createRequire",
    requireAliases: new Set(),
    wrapperNames: new Set(),
    fileName,
  };

  function flag(node: ts.Node, kind: ChildProcessViolationKind, specifier: string | null): void {
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    violations.push({
      file: fileName,
      line: line + 1,
      kind,
      specifier,
      callText: node.getText(sf).split("\n")[0].slice(0, 120),
    });
  }

  // Pass 1: local import name for createRequire (from "node:module" / "module").
  function collectImportName(node: ts.Node): void {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteralLike(node.moduleSpecifier) &&
      /^(node:)?module$/.test(node.moduleSpecifier.text)
    ) {
      const bindings = node.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const el of bindings.elements) {
          const canonical = el.propertyName ? el.propertyName.text : el.name.text;
          if (canonical === "createRequire") ctx.createRequireLocalName = el.name.text;
        }
      }
    }
    ts.forEachChild(node, collectImportName);
  }
  collectImportName(sf);

  // Pass 2: fixed-point alias + same-file pass-through wrapper-function collection
  // (handles transitive aliases regardless of declaration order).
  function collectAliasesOnce(node: ts.Node): boolean {
    let added = false;
    function visit(n: ts.Node): void {
      if (ts.isVariableDeclaration(n) && n.initializer && ts.isIdentifier(n.name)) {
        const init = unwrapExpr(n.initializer);
        const name = n.name.text;
        if (!ctx.requireAliases.has(name)) {
          if (isCreateRequireCall(init, ctx)) {
            ctx.requireAliases.add(name);
            added = true;
          } else if (ts.isIdentifier(init) && (init.text === "require" || ctx.requireAliases.has(init.text))) {
            ctx.requireAliases.add(name);
            added = true;
          }
        }
      }
      // wrapper function: const NAME = (param) => <requireLikeCall>(param)  [arrow, single-param]
      if (
        ts.isVariableDeclaration(n) &&
        n.initializer &&
        ts.isIdentifier(n.name) &&
        ts.isArrowFunction(n.initializer) &&
        n.initializer.parameters.length >= 1 &&
        ts.isIdentifier(n.initializer.parameters[0].name)
      ) {
        const paramName = (n.initializer.parameters[0].name as ts.Identifier).text;
        const body = n.initializer.body;
        const bodyCall = ts.isBlock(body)
          ? body.statements.length === 1 && ts.isReturnStatement(body.statements[0]) && body.statements[0].expression
            ? unwrapExpr(body.statements[0].expression)
            : null
          : unwrapExpr(body as ts.Expression);
        if (
          bodyCall &&
          ts.isCallExpression(bodyCall) &&
          isRequireLikeCallee(bodyCall.expression, ctx) &&
          bodyCall.arguments.length >= 1 &&
          ts.isIdentifier(bodyCall.arguments[0]) &&
          (bodyCall.arguments[0] as ts.Identifier).text === paramName &&
          !ctx.wrapperNames.has(n.name.text)
        ) {
          ctx.wrapperNames.add(n.name.text);
          added = true;
        }
      }
      ts.forEachChild(n, visit);
    }
    visit(node);
    return added;
  }
  // Iterate until stable — the finite alias/wrapper set already guarantees termination;
  // a generous safety cap avoids any pathological runaway (not a completeness limit).
  for (let i = 0; i < 64 && collectAliasesOnce(sf); i++) {
    /* loop until fixed point */
  }

  function scanEvalLikeArg(callNode: ts.Node, arg: ts.Expression): void {
    const folded = foldConstantString(arg, ctx);
    if (folded === null) {
      flag(callNode, "opaque require()/import()-like call", null);
      return;
    }
    const nested = findChildProcessImports(`${ctx.fileName}#eval`, folded);
    if (nested.length > 0) flag(callNode, "dynamic code (eval/Function)", nested[0].specifier ?? "child_process");
  }

  // Pass 3: detection.
  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
      if (FORBIDDEN_SPECIFIERS.has(node.moduleSpecifier.text)) flag(node, "import", node.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
      if (FORBIDDEN_SPECIFIERS.has(node.moduleSpecifier.text)) flag(node, "export-from", node.moduleSpecifier.text);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteralLike(node.moduleReference.expression)
    ) {
      if (FORBIDDEN_SPECIFIERS.has(node.moduleReference.expression.text)) {
        flag(node, "import-equals require", node.moduleReference.expression.text);
      }
    } else if (ts.isCallExpression(node)) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isFunctionOrEval = !isDynamicImport && isEvalLikeCallee(node.expression);
      const isRequireLike = !isDynamicImport && !isFunctionOrEval && isRequireLikeCallee(node.expression, ctx);

      if (isFunctionOrEval && node.arguments.length > 0) {
        for (const arg of node.arguments) scanEvalLikeArg(node, arg);
      } else if (isDynamicImport && node.arguments.length > 0) {
        const folded = foldConstantString(node.arguments[0], ctx);
        if (folded !== null) {
          if (FORBIDDEN_SPECIFIERS.has(folded)) flag(node, "dynamic import()", folded);
        } else {
          flag(node, "opaque require()/import()-like call", null);
        }
      } else if (isRequireLike) {
        const moduleArg = moduleArgFromCallOrApply(node, ctx) ?? (node.arguments.length > 0 ? node.arguments[0] : null);
        if (moduleArg) {
          const folded = foldConstantString(moduleArg, ctx);
          if (folded !== null) {
            if (FORBIDDEN_SPECIFIERS.has(folded)) flag(node, "require()-like", folded);
          } else {
            flag(node, "opaque require()/import()-like call", null);
          }
        }
      }
    } else if (
      ts.isNewExpression(node) &&
      (ts.isIdentifier(node.expression)
        ? node.expression.text === "Function"
        : isGlobalThisDot(node.expression, "Function"))
    ) {
      for (const arg of node.arguments ?? []) scanEvalLikeArg(node, arg);
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);

  // Floor-guarantee union (never intersection): if the precision AST layer above
  // found nothing but the comment-stripped substring scan still fires, the file is
  // NOT clean — append a synthetic violation rather than silently trusting the AST
  // layer's classification. This is what makes "never looser than the old scan"
  // hold by construction instead of by chasing individual indirection forms.
  if (violations.length === 0) {
    const idx = forbiddenSubstringIndexOutsideComments(sf);
    if (idx !== -1) {
      const { line } = sf.getLineAndCharacterOfPosition(idx);
      violations.push({
        file: fileName,
        line: line + 1,
        kind: "substring-scan floor guarantee",
        specifier: null,
        callText: sourceText
          .slice(Math.max(0, idx - 40), idx + 60)
          .replace(/\s+/g, " ")
          .trim(),
      });
    }
  }

  return violations;
}
