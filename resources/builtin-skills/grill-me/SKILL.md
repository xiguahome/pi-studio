---
name: grill-me
description: Interview the user relentlessly about a plan or design until reaching shared understanding, resolving each branch of the decision tree. Use when user wants to stress-test a plan, get grilled on your design, or mentions "grill me".
description_zh: "深度追问式方案审查：逐层拆解设计决策，直到达成共识"
description_en: "Relentless interview to stress-test your plan, resolving each decision branch one by one"
version: 1.0.0
homepage: https://github.com/mattpocock/skills
allowed-tools: Read,Grep,ask_user_question
display_name: "grill-me"
display_name_en: "grill-me"
visibility: "public"
---

# Grill Me

## What to do

Interview the user relentlessly about every aspect of their plan until we reach a shared understanding. Walk down each branch of the design tree, resolving dependencies between decisions one-by-one.

**IMPORTANT - You MUST use the `ask_user_question` tool for ALL questions.** Do NOT ask questions in plain text. Use the tool to present structured options to the user.

**For each question round**:
1. Use `ask_user_question` with up to 4 questions at a time
2. Wait for the user's response
3. Analyze the answers
4. Continue with follow-up questions if needed (in another `ask_user_question` call)

If something can be answered by exploring the codebase, use Read/Grep to answer it yourself — don't ask the user.

**Question guidelines**:
- Each question MUST have 2-4 clear options
- Include an "Other" option (the tool auto-appends "Type something." for free-text answers)
- Put your recommended answer FIRST and add "(Recommended)" to its label
- Use `multiSelect: true` only when multiple answers are genuinely valid simultaneously
- Headers should be short (≤16 chars): e.g., "项目", "角色", "范围"

**How to structure the session**:
1. List the top-level decision branches you see in the plan (3–6 items)
2. Pick the most foundational branch first (others often depend on it)
3. Walk each branch to completion before moving to the next
4. Within a branch, resolve sub-decisions in dependency order

**When to stop**: The session is complete when all branches are resolved and there are no open "it depends" answers remaining. Close with a one-paragraph summary of the key decisions made.

## Difference from grill-with-docs

**grill-me** = pure conversational interrogation of a plan. No documentation is read or updated. Use when the plan is still conceptual and you just need to think it through.

**grill-with-docs** = interrogation anchored to the project's existing domain model (CONTEXT.md, ADRs). Terminology is challenged against the glossary, and decisions that crystallise are written into CONTEXT.md / ADRs in real time. Use when the project does NOT have an established domain model that the new plan must align with.

## When to use

Invoke this skill when:
- The user wants to stress-test a plan or design decision
- The user says "grill me" or "challenge my thinking"
- You need to surface hidden assumptions or unresolved trade-offs before implementation begins
- The project does NOT yet have a domain model / CONTEXT.md (if it does, prefer grill-with-docs)

## Tools

- **Read**: Read existing code, specs, or documentation to answer questions without asking the user
- **Grep**: Search the codebase to resolve factual questions about current behaviour
- **ask_user_question**: Ask the user structured questions with typed options (REQUIRED for all questions)
