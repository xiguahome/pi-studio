#!/usr/bin/env node
// @ts-check
/**
 * patch-pi-plan-mode.mjs — two fixes for pi-studio's Plan mode UX.
 *
 * 1. Route question prompts to ask_user_question (src/prompt.ts + the tool's
 *    promptGuidelines in src/plan-mode.ts).
 *
 *    pi-plan-mode's prompt tells the model to ask questions via
 *    plan_mode_question, whose schema is a strict subset of the built-in
 *    ask_user_question tool (provided by @juicesharp/rpiv-ask-user-question,
 *    which advertises multiSelect and options[].preview). Models carry over
 *    that richer shape and the `additionalProperties: false` schema rejects
 *    the call before the extension ever sees it. ask_user_question is the
 *    better target anyway: it ships with every pi-studio install, and its RPC
 *    walker already speaks the multiSelect "1,3" answer format that
 *    pi-studio's drainQuestionnaire produces. plan_mode_question stays
 *    registered as a fallback — fix 2 below keeps it usable when the model
 *    still calls it.
 *
 * 2. Accept ask_user_question's richer parameter shape on plan_mode_question
 *    (src/question-tool.ts).
 *
 *    Declares question-level `multiSelect` and option-level `preview` as
 *    accepted-and-ignored so fallback plan_mode_question calls are not
 *    rejected by schema validation. Behavior is unchanged:
 *    - normalizePlanModeQuestionParams() reads only id/header/question and
 *      label/description, so the extra fields never reach PlanModeQuestion.
 *    - pi-studio's parsePlanModeQuestions() likewise ignores them: questions
 *      render single-select and answers ride the existing "N. label — desc"
 *      select-response path.
 *
 * 3. Default implementation-plan retention to "clear-after-first-run"
 *    (src/settings.ts).
 *
 *    Upstream defaults to "keep" — the "Implementation plan active" bar
 *    lingers until /plan exit. pi-studio wants it to auto-dismiss once the
 *    first implementation run settles, so every install behaves the same
 *    without shipping a per-user config file. An explicit
 *    implementationPlanRetention in pi-plan-mode.json still wins via ??.
 *
 * The plugin ships as raw TS loaded via `pi.extensions` → ./src/index.ts, so
 * patching the source is enough — no build step. It lives in pi's managed npm
 * dir, which patch-package cannot reach (it only patches the project
 * node_modules), hence this dedicated idempotent script. Re-run it after
 * upgrading the plugin (same pattern as patch-pi-tasks.mjs et al.).
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi-studio");
const pkgDir = join(agentDir, "npm", "node_modules", "@narumitw", "pi-plan-mode");
const fileRel = join("src", "question-tool.ts");

// One entry per schema property to insert. `anchor` must match exactly one
// line; inserted lines inherit the anchor's indentation (relative tabs inside
// the inserted text), so the patch survives upstream reformatting of the
// surrounding whitespace. `marker` is a substring unique to the inserted text
// and makes each entry independently idempotent.
const INSERTS = [
  {
    // Question-level: sits between `question` and `options` properties.
    anchor: 'question: { type: "string", description: "Single-sentence prompt shown to the user." },',
    marker: "Plan-mode questions are always single-select",
    lines: [
      "multiSelect: {",
      '\ttype: "boolean",',
      "\tdescription:",
      '\t\t"Accepted for ask_user_question compatibility; Plan-mode questions are always single-select and this flag is ignored.",',
      "},",
    ],
  },
  {
    // Option-level: sits after `label` (schema property order is irrelevant).
    anchor: 'label: { type: "string", description: "User-facing label (1-5 words)." },',
    marker: "ignored by the Plan-mode question UI",
    lines: [
      "preview: {",
      '\ttype: "string",',
      "\tdescription:",
      '\t\t"Accepted for ask_user_question compatibility; ignored by the Plan-mode question UI.",',
      "},",
    ],
  },
];

// Text rewrites (fix 1). `sources` lists the upstream spelling; all hits are
// rewritten to `target`. A rule is considered applied when `target` is present
// and no source matches — keeping the script idempotent across re-runs.
const REPLACEMENTS = [
  {
    file: join("src", "prompt.ts"),
    rules: [
      {
        sources: ["Use plan_mode_question for important preferences"],
        target: "Use ask_user_question for important preferences",
      },
      {
        sources: ["If plan_mode_question returns cancelled or ui_unavailable"],
        target: "If ask_user_question returns cancelled or ui_unavailable",
      },
      {
        sources: ["use plan_mode_question. If interactive UI is unavailable"],
        target: "use ask_user_question. If interactive UI is unavailable",
      },
      {
        sources: ["continue planning with plan_mode_question instead of calling"],
        target: "continue planning with ask_user_question instead of calling",
      },
    ],
  },
  {
    file: join("src", "plan-mode.ts"),
    rules: [
      {
        sources: ['"In Plan mode, use plan_mode_question for important preferences'],
        target: '"In Plan mode, use ask_user_question for important preferences',
      },
    ],
  },
  {
    file: join("src", "settings.ts"),
    rules: [
      {
        // Fix 3: default retention so the implementation-plan bar auto-dismisses.
        sources: ['return settings.implementationPlanRetention ?? "keep";'],
        target: 'return settings.implementationPlanRetention ?? "clear-after-first-run";',
      },
    ],
  },
];

if (!existsSync(pkgDir)) {
  console.log(`[patch-pi-plan-mode] plugin not found at ${pkgDir} — skipping (install it first).`);
  process.exit(0);
}

const filePath = join(pkgDir, fileRel);
if (!existsSync(filePath)) {
  console.warn(`[patch-pi-plan-mode] WARN ${fileRel} missing — plugin structure changed?`);
  process.exit(0);
}

const content = readFileSync(filePath, "utf8");
const eol = content.includes("\r\n") ? "\r\n" : "\n";
const lines = content.split(/\r?\n/);

let inserted = 0;
for (const { anchor, marker, lines: newLines } of INSERTS) {
  if (content.includes(marker)) {
    console.log(`[patch-pi-plan-mode] ${marker.slice(0, 40)}… already patched — skipping.`);
    continue;
  }
  const hitIndexes = lines
    .map((line, index) => (line.includes(anchor) ? index : -1))
    .filter((index) => index >= 0);
  if (hitIndexes.length !== 1) {
    console.warn(
      `[patch-pi-plan-mode] WARN anchor matched ${hitIndexes.length} lines (expected 1): ${JSON.stringify(anchor)}`,
    );
    continue;
  }
  const hitIndex = hitIndexes[0];
  const indent = lines[hitIndex].match(/^[\t ]*/)[0];
  const block = newLines.map((line) => (line ? indent + line : line));
  lines.splice(hitIndex + 1, 0, ...block);
  inserted++;
}

if (inserted > 0) {
  writeFileSync(filePath, lines.join(eol), "utf8");
  console.log(`[patch-pi-plan-mode] patched ${fileRel} (${inserted} propert${inserted === 1 ? "y" : "ies"} added).`);
} else {
  console.log(`[patch-pi-plan-mode] ${fileRel}: nothing to insert.`);
}

// Fix 1: rewrite the question-tool guidance to ask_user_question.
let replaced = 0;
for (const { file, rules } of REPLACEMENTS) {
  const target = join(pkgDir, file);
  if (!existsSync(target)) {
    console.warn(`[patch-pi-plan-mode] WARN ${file} missing — plugin structure changed?`);
    continue;
  }
  let content = readFileSync(target, "utf8");
  let changed = false;
  let skipped = 0;
  for (const { sources, target: replacement } of rules) {
    const hit = sources.find((s) => content.includes(s));
    if (hit) {
      content = content.replaceAll(hit, replacement);
      changed = true;
    } else if (content.includes(replacement)) {
      skipped++;
    } else {
      console.warn(
        `[patch-pi-plan-mode] WARN ${file}: none of ${JSON.stringify(sources)} nor target found — structure changed?`,
      );
    }
  }
  if (changed) {
    writeFileSync(target, content, "utf8");
    replaced++;
    console.log(`[patch-pi-plan-mode] patched ${file}`);
  } else if (skipped) {
    console.log(`[patch-pi-plan-mode] ${file} already patched — skipping.`);
  }
}

if (inserted > 0 || replaced > 0) {
  console.log("[patch-pi-plan-mode] restart pi-studio so the plugin reloads.");
}
