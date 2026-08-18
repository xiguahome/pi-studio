"use client";

import { useEffect, useState } from "react";

/**
 * Lazy-loaded `react-syntax-highlighter` infrastructure.
 *
 * `react-syntax-highlighter` with Prism bundles ALL ~300+ language definitions
 * (~700 KB minified). This module moves that weight out of the initial client
 * bundle: the first non-streaming CodeBlock triggers a single dynamic import,
 * and all subsequent CodeBlocks reuse the cached module.
 *
 * Usage:
 *   const mod = useHighlighter(isStreaming);
 *   // mod === null → render plain <pre> fallback (same as streaming mode)
 *   // mod !== null → render <mod.Prism style={mod.vscDarkPlus / mod.vs} …>
 */

export type HighlighterModule = {
  Prism: typeof import("react-syntax-highlighter")["Prism"];
  vs: typeof import("react-syntax-highlighter/dist/cjs/styles/prism")["vs"];
  vscDarkPlus: typeof import("react-syntax-highlighter/dist/cjs/styles/prism")["vscDarkPlus"];
};

let highlighterPromise: Promise<HighlighterModule> | null = null;

export function loadHighlighter(): Promise<HighlighterModule> {
  if (!highlighterPromise) {
    highlighterPromise = Promise.all([
      import("react-syntax-highlighter"),
      import("react-syntax-highlighter/dist/cjs/styles/prism"),
    ]).then(([main, styles]) => ({
      Prism: main.Prism,
      vs: styles.vs,
      vscDarkPlus: styles.vscDarkPlus,
    }));
  }
  return highlighterPromise;
}

/**
 * Returns the highlighter module once loaded, or `null` while loading.
 * The import is triggered on mount unless `disabled` is true (e.g. while
 * the owning message is still streaming — no point loading until needed).
 */
export function useHighlighter(disabled: boolean): HighlighterModule | null {
  const [mod, setMod] = useState<HighlighterModule | null>(null);

  useEffect(() => {
    if (disabled || mod) return;
    let cancelled = false;
    loadHighlighter().then((m) => {
      if (!cancelled) setMod(m);
    });
    return () => { cancelled = true; };
  }, [disabled, mod]);

  return mod;
}
