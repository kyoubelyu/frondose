export interface SystemPromptBands {
  boundary: string;
  soul: string;
  checkpoint: string;
}

/** Separator between bands. Invariant per CLAUDE.md §1 Product Contract. */
export const BAND_SEPARATOR = "\n\n---\n\n";

/**
 * Compose 3-band system prompt: Boundary → Soul → Checkpoint.
 * Order is invariant per CLAUDE.md §1 Product Contract.
 */
export function composeSystemPrompt(bands: SystemPromptBands): string {
  return `${bands.boundary}${BAND_SEPARATOR}${bands.soul}${BAND_SEPARATOR}${bands.checkpoint}`;
}
