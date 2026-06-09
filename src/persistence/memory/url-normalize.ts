/** Trailing-slash normalization per mai-linkedin/src/memory/memoryRepository.ts. */
export function normalizeProfileUrl(url: string): string {
  return `${url.replace(/\/+$/, "")}/`;
}
