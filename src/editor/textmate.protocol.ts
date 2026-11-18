//! Messages between the UI thread (`textmate.ts`) and the tokenizing worker
//! (`textmate.worker.ts`). Kept apart so importing it runs no worker code.

import type { IRawTheme } from "vscode-textmate";

export type ToWorker =
  | { type: "theme"; id: number; theme: IRawTheme }
  | { type: "injections"; injections: Record<string, string[]> }
  | { type: "grammar"; requestId: number; content: string | null; path: string }
  | { type: "tokenize"; id: number; doc: string; scope: string; text: string }
  | { type: "close"; doc: string };

export type FromWorker =
  | { type: "loadGrammar"; requestId: number; scope: string }
  | { type: "theme"; id: number; colorMap: string[] }
  | { type: "tokens"; id: number; data: Uint32Array | null };

/** Semantic token types are `tm0`..`tm{MAX_COLORS - 1}` (colour-map indices). */
export const MAX_COLORS = 1024;
