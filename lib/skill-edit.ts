import { parseFrontmatter } from "@earendil-works/pi-coding-agent";

// Mirrors the SDK's skill spec limits (core/skills.js) so edits that would
// make the loader drop the skill are rejected up front.
const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;

export interface SkillContentValidation {
  ok: boolean;
  error?: string;
}

/**
 * Validate SKILL.md content before saving: a YAML frontmatter block must be
 * present and parse, with non-empty `name` and `description` fields within
 * the SDK's length limits.
 */
export function validateSkillMarkdown(content: string): SkillContentValidation {
  if (!content.trim()) {
    return { ok: false, error: "SKILL.md is empty" };
  }
  if (!/^---\r?\n/.test(content)) {
    return { ok: false, error: "SKILL.md must start with a --- frontmatter block" };
  }

  let frontmatter: Record<string, unknown>;
  try {
    ({ frontmatter } = parseFrontmatter<Record<string, unknown>>(content));
  } catch (e) {
    return {
      ok: false,
      error: `Invalid frontmatter: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  const name = frontmatter.name;
  if (typeof name !== "string" || !name.trim()) {
    return { ok: false, error: "Frontmatter must define a non-empty \"name\"" };
  }
  if (name.length > MAX_NAME_LENGTH) {
    return { ok: false, error: `"name" exceeds ${MAX_NAME_LENGTH} characters` };
  }

  const description = frontmatter.description;
  if (typeof description !== "string" || !description.trim()) {
    return { ok: false, error: "Frontmatter must define a non-empty \"description\"" };
  }
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    return { ok: false, error: `"description" exceeds ${MAX_DESCRIPTION_LENGTH} characters` };
  }

  return { ok: true };
}
