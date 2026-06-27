export function normalizeForComparison(value: string): string {
  return value
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    .replace(/\n+$/, "")
    .replace(/[ \t]+/g, " ")
    .trim();
}

export function textsMatch(intended: string, observed: string): boolean {
  return normalizeForComparison(intended) === normalizeForComparison(observed);
}
