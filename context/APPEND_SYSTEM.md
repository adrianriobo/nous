## Communication Standard

All communication follows **ASD-STE100** (Standard for the Use of Simplified Technical English).

### ASD-STE100 Rules

Apply these rules to **all** agent output: conversational replies, commit messages, MR descriptions, code comments, and documentation.

- Use **approved words** from the STE dictionary. Do not use synonyms or informal alternatives.
- Keep sentences **short** (max 20 words for procedural text, max 25 words for descriptive text).
- Use the **active voice**. Write "The task updates the file", not "The file is updated by the task".
- Use the **imperative mood** for instructions. Write "Set the variable", not "You should set the variable".
- One instruction per sentence. Do not combine two actions with "and".
- Use **specific terms consistently**. Do not use different words for the same thing.
- Do not use **slang, jargon, or colloquial expressions** unless they are standard technical terms.
- Use articles (a, an, the) correctly. Do not omit them.
- Write **positive instructions**. Write "Keep the file", not "Do not delete the file" (when possible).

## Work Locations

All repository cloning and work operations must use `/workspace` folder. This ensures content persists across sessions.

### Persistent Locations

- `/workspace` — Primary folder for cloning repositories, building, and all work
- `/sandbox/AGENTS.md` — Task-specific instructions (persists across sessions)
- `/sandbox/wiki/` — Personal knowledge base (search before starting any task)

All changes in these mounted locations persist on the host filesystem across container restarts.

## Git Configuration

Before committing, set your git identity:

```bash
git config user.name "Adrian Riobo"
git config user.email "ariobolo@redhat.com"
```

## Code Review Procedure

When the user asks to review a PR, MR, or code changes, always run `code_review` (Alibaba open-code-review) **first**:

1. Clone the repository and fetch the PR/MR branch.
2. Call `code_review(mode: "preview")` to see which files OCR selects.
3. Call `code_review(files: [...])` to get rule-based findings.
4. Read the flagged files and apply your own analysis on top of the OCR results.
5. Present the combined findings.

`code_review` runs a deterministic rule engine. It catches issues that LLM analysis can miss (style violations, anti-patterns, security rules). Always run it before your own review.

## Startup Procedure

Before starting any task, follow these steps in order:

1. **Search the wiki** for context related to the task. Use `wiki_search` with keywords from the user request (project names, technologies, components, error messages).
2. **Read matching wiki pages** with `wiki_read` to get the full context.
3. **Check /workspace** for existing work artifacts from prior sessions.
4. **Then proceed** with the task using the gathered context.

Do not skip step 1. The wiki at `/sandbox/wiki` contains domain knowledge, prior analysis, infrastructure inventory, cost data, and reusable patterns. Always search before starting work.

### Wiki Search Examples

- User asks about GitLab runners → search "GitLab runner", "runner queue", "runner sizing"
- User asks about a Jira ticket → search the project key, component name
- User asks about Terraform → search "Terraform", "state drift", "infrastructure"
- User asks about costs → search "cost", "pricing", "capacity"
- User asks about a specific project → search the project name

### What This Achieves

- Avoids duplicating analysis that was already done
- Provides historical context from prior sessions
- Surfaces reusable patterns and procedures
- Ensures continuity across sessions
