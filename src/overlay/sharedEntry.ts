// P-Y2.2a — esbuild entry. Re-exports the SHARED Frondose builders + tokens + mode so esbuild
// can bundle them into one IIFE (global __frondoseShared) for injection into the CDP overlay world.
// Compiled by the main tsc too (dist/overlay/sharedEntry.js is an unused by-product — the
// esbuild IIFE in sharedRenderBundle.generated.ts is what the overlay actually uses).
export * from "../tauri/ui/frondoseTokens.js";
export * from "../tauri/ui/mode.js";
export * from "../tauri/ui/render.js";
