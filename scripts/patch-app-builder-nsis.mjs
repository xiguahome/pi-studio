#!/usr/bin/env node
// Idempotent patch for electron-builder's NSIS templates.
//
// A few MessageBox calls in the stock templates lack /SD, so in SILENT
// install mode (/S) they are still created but invisible — the installer
// dead-waits forever on a dialog nobody can see (hit in the wild: the
// "uninstallFailed" box after an interrupted update left a half-uninstalled
// state; the /S repair install hung at 0% CPU forever).
//
// Patched files (under node_modules/app-builder-lib/templates/nsis/):
//   include/installUtil.nsh       — uninstallFailed / Unsupported ROOT_KEY
//   include/extractAppPackage.nsh — decompressionFailed
// All get an /SD IDOK so silent installs auto-answer and move on.

import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const patches = [
  {
    // Disable the "run the old uninstaller first" pass: it is the root cause
    // of every update failure on this app (minutes deleting the old install,
    // the atomic INSTDIR rename racing AV/indexer file handles → exit code
    // 2, and historically the retry dialogs). The one-click install just
    // extracts over the old files, which is all we need; the junction at
    // pi-web/node_modules keeps the shared dependency tree outside the
    // install dir anyway. Both functions early-Return AFTER popping their
    // stack argument (the macros Push before Call — balance must hold) and
    // the call sites in installSection.nsh stay intact, otherwise NSIS
    // warns "function not referenced" and electron-builder fails the build.
    file: "node_modules/app-builder-lib/templates/nsis/include/installUtil.nsh",
    replacements: [
      [
        `  ClearErrors
  Exch $rootKey

  Push 0`,
        `  ClearErrors
  Exch $rootKey

  ; pi-studio patch: old-uninstaller pass disabled — updates extract-overwrite
  Return

  Push 0`,
      ],
      [
        `  Exch $rootKey_uninstallResult`,
        `  Exch $rootKey_uninstallResult

  ; pi-studio patch: disabled along with uninstallOldVersion
  Return`,
      ],
    ],
  },
  {
    file: "node_modules/app-builder-lib/templates/nsis/include/installUtil.nsh",
    replacements: [
      ['MessageBox MB_OK "Unsupported ${ROOT_KEY}"', 'MessageBox MB_OK "Unsupported ${ROOT_KEY}" /SD IDOK'],
      [
        'MessageBox MB_OK|MB_ICONEXCLAMATION "$(uninstallFailed): $R0"',
        'MessageBox MB_OK|MB_ICONEXCLAMATION "$(uninstallFailed): $R0" /SD IDOK',
      ],
    ],
  },
  {
    file: "node_modules/app-builder-lib/templates/nsis/include/extractAppPackage.nsh",
    replacements: [
      [
        'MessageBox MB_OK|MB_ICONEXCLAMATION "$(decompressionFailed)$\\n$R0"',
        'MessageBox MB_OK|MB_ICONEXCLAMATION "$(decompressionFailed)$\\n$R0" /SD IDOK',
      ],
      [
        // The extract-retry MessageBox reuses the "appCannotBeClosed" text
        // ("pi-studio 无法关闭") but is really about FILE locks: antivirus
        // real-time scanning locks freshly extracted exe/dll for a few
        // seconds. Replace the dialog with a patient bounded retry so both
        // silent AND manual (non-silent) installs self-heal instead of
        // trapping the user in a retry loop.
        `    \${if} $R1 < 5
      # Try copying a few times before asking for a user action.
      Goto RetryExtract7za
    \${else}
      MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appCannotBeClosed)" /SD IDRETRY IDCANCEL AbortExtract7za
    \${endIf}`,
        `    Sleep 1000
    \${if} $R1 < 150
      # pi-studio patch: AV real-time scanning locks freshly written files for
      # seconds; keep retrying patiently instead of trapping the user in a
      # retry dialog (whose text misleadingly says the app cannot be closed).
      Goto RetryExtract7za
    \${else}
      Goto AbortExtract7za
    \${endIf}`,
      ],
    ],
  },
];

let changed = 0;
for (const { file, replacements } of patches) {
  const full = resolve(root, file);
  if (!existsSync(full)) {
    console.error(`[patch-app-builder-nsis] MISSING ${file} — skip`);
    continue;
  }
  let text = readFileSync(full, "utf8");
  for (const [from, to] of replacements) {
    if (text.includes(to)) continue; // already patched
    if (!text.includes(from)) {
      console.error(`[patch-app-builder-nsis] pattern not found in ${file}: ${from}`);
      process.exitCode = 1;
      continue;
    }
    text = text.replace(from, to);
    changed++;
  }
  writeFileSync(full, text);
}
console.log(`[patch-app-builder-nsis] ${changed} replacement(s) applied`);
