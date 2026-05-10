import chalk from "chalk";

/**
 * Line-oriented terminal markdown renderer. Buffered (whole-text) input.
 * Covers the 95% of patterns LLMs emit. Not a full CommonMark renderer.
 */
export function renderMarkdown(text: string): string {
  const out: string[] = [];
  const lines = text.split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    // fenced code block
    const fence = /^```(\w*)\s*$/.exec(line);
    if (fence) {
      const lang = fence[1] ?? "";
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i] ?? "")) {
        body.push(lines[i] ?? "");
        i++;
      }
      i++; // skip closing fence
      out.push(chalk.dim(`╭─ ${lang}`));
      for (const b of body) out.push(chalk.cyan(`│ ${b}`));
      out.push(chalk.dim("╰─"));
      continue;
    }
    // headers
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      out.push(chalk.bold.underline(h[2] ?? ""));
      i++;
      continue;
    }
    // blockquote
    if (line.startsWith("> ")) {
      out.push(chalk.gray(`│ ${line.slice(2)}`));
      i++;
      continue;
    }
    // unordered list
    const ul = /^(\s*)[-*]\s+(.*)$/.exec(line);
    if (ul) {
      out.push(`${ul[1]}• ${renderInline(ul[2] ?? "")}`);
      i++;
      continue;
    }
    // ordered list
    const ol = /^(\s*)(\d+)\.\s+(.*)$/.exec(line);
    if (ol) {
      out.push(`${ol[1]}${ol[2]}. ${renderInline(ol[3] ?? "")}`);
      i++;
      continue;
    }
    // table separator row (like |---|---|) — pass through dim
    if (/^\s*\|?\s*[-:]+\s*(\|\s*[-:]+\s*)+\|?\s*$/.test(line)) {
      out.push(chalk.dim(line));
      i++;
      continue;
    }
    out.push(renderInline(line));
    i++;
  }
  return out.join("\n");
}

function renderInline(s: string): string {
  // inline code first (so we don't bold-mangle code content)
  s = s.replace(/`([^`]+)`/g, (_m, c) => chalk.yellow(c));
  // bold
  s = s.replace(/\*\*([^*]+)\*\*/g, (_m, c) => chalk.bold(c));
  s = s.replace(/__([^_]+)__/g, (_m, c) => chalk.bold(c));
  // italic
  s = s.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, (_m, c) => chalk.italic(c));
  s = s.replace(/(?<!_)_([^_]+)_(?!_)/g, (_m, c) => chalk.italic(c));
  return s;
}
