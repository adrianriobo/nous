# Model-specific subagents

The `subagent` tool adds separate model sessions to the existing router. It does not change the main session model.

Ask for a subagent explicitly. For example:

> Use the scout subagent to find the authentication code.

> Use the reviewer subagent to inspect the changes in this repository.

> Use the advanced reviewer subagent to assess this design.

> Use the wiki researcher subagent to collect our notes about Konflux capacity.

> Use the Slack researcher subagent to summarize this thread: https://redhat.slack.com/archives/C08LVA9E1SS/p1769005300000000

| Role | Model | Charge | Task |
|---|---|---|---|
| `scout` | DeepSeek V4.1 Flash | Free hosted model | Find files and evidence. |
| `reviewer` | GLM 5.3 | Free hosted model | Inspect changes and report defects. |
| `advanced-reviewer` | GPT 6.1 Terra | Paid | Analyze difficult changes. |
| `wiki-researcher` | DeepSeek V4.1 Flash | Free hosted model | Search the wiki and return a sourced summary. |
| `slack-researcher` | DeepSeek V4.1 Flash | Free hosted model | Read one thread and return a timeline. |

The advanced reviewer needs interactive confirmation for every invocation. Print and other non-interactive modes cannot approve it. The confirmation permits one subagent invocation. That invocation can make multiple model requests. Confirm gateway billing limits separately.

A child receives the delegated task and its own instructions. It does not receive the main conversation automatically. Include the relevant paths and constraints in the task.

## Tools for each role

| Role | Tools | Write access |
|---|---|---|
| `scout`, `reviewer`, `advanced-reviewer` | `read`, `grep`, `find`, `ls` | None |
| `wiki-researcher` | `wiki_search`, `wiki_read` | None |
| `slack-researcher` | `slack_thread` | None |

`wiki_ingest` is not available to a child. `slack_thread` reads replies only. The tool cannot post, edit, or delete messages. Children cannot call `bash`, edit files, use MCP tools, or call another subagent through the provided tool list.

## Wiki researcher

The wiki researcher keeps large page sets out of the main context. It returns a smaller result with sources.

1. Ask for the wiki researcher.
2. Give the research question.
3. Read the cited pages before you use an important finding.

The wiki search matches the complete query string. A long sentence can miss a relevant page. The child instruction tells the model to run several short queries. The result should contain page paths, short excerpts, conflicts between pages, and search limits.

Use the main session to make the final decision. Use the reviewer or advanced reviewer for difficult analysis.

## Slack researcher

The Slack researcher reads one thread and its replies. It returns decisions, owners, dates, open questions, and message links. The result identifies incomplete retrieval and access errors.

Give the channel ID and the thread timestamp. A thread URL contains both values:

`https://redhat.slack.com/archives/C08LVA9E1SS/p1769005300000000`

- Channel ID: `C08LVA9E1SS`
- Thread timestamp: `1769005300.000000`

The timestamp has six digits after the decimal point. Add the three trailing zeros of the URL value as shown.

The reader needs these environment variables:

- `SLACK_XOXC_TOKEN`
- `SLACK_XOXD_TOKEN`
- `SLACK_WORKSPACE` — optional, default `redhat`

The reader uses `https://slack.com/api`. Set `SLACK_API_BASE` only for a test server. The OpenShell policy must allow the Slack endpoint. See [nous-policy-slack.yaml](../security/nous-policy-slack.yaml).

Slack threads can contain confidential data. Send them only to a model that your organization approves for that data. The child sends the thread text to the EnMaaS gateway.

The default limits are 100 messages and 200 messages maximum. Each message is limited to 1,500 characters. The complete result is limited to 24,000 characters.

## Execution limits

Each child runs in a separate pi process. The child uses the configured EnMaaS provider directly. It does not use `router/auto`. OpenAI models use the Responses API from the EnMaaS catalog. No model fallback occurs. A failure returns an error.

The parent allows four concurrent children and eight calls per user prompt. Each child has a 120-second limit and a limit of 20 model turns. The parent stops a child when the user cancels the tool call. The parent returns at most 32,000 characters of the final answer. The result identifies the role and model. Pi receives the token usage reported by the child. The EnMaaS catalog reports zero cost to pi. Use gateway billing data for actual charges.

## Security limits

Child processes share the parent filesystem, network policy, operating-system identity, and EnMaaS credentials. A separate process is not a security sandbox. The tool list limits model actions through pi. It does not protect files that the child can read. The OpenShell policy continues to apply to child processes.

Wiki pages, repository content, Slack messages, and subagent output are untrusted data. The parent must verify findings before it uses them. A different model does not guarantee an independent or correct review. Measure quality against the existing router before you enable automatic delegation.

Subagents can reduce cost and context use. They can also hide a bad summary. Keep citations in the result and spot-check important findings.
