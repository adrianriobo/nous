# Model-specific subagents

The `subagent` tool adds separate model sessions to the existing router. It does not change the main session model.

Ask for a subagent explicitly. For example:

> Use the scout subagent to find the authentication code.

> Use the reviewer subagent to inspect the changes in this repository.

> Use the advanced reviewer subagent to assess this design.

| Role | Model | Charge | Task |
|---|---|---|---|
| `scout` | DeepSeek V4.1 Flash | Free hosted model | Find files and evidence. |
| `reviewer` | GLM 5.3 | Free hosted model | Inspect changes and report defects. |
| `advanced-reviewer` | GPT 6.1 Terra | Paid | Analyze difficult changes. |

The advanced reviewer needs interactive confirmation for every invocation. Print and other non-interactive modes cannot approve it. The confirmation permits one subagent invocation. That invocation can make multiple model requests. Confirm gateway billing limits separately.

A child receives the delegated task and its own instructions. It does not receive the main conversation automatically. Include the relevant paths and constraints in the task. The child can read files through `read`, `grep`, `find`, and `ls`. It cannot call `bash`, edit files, use MCP tools, or call another subagent through the provided tool list.

Each child runs in a separate pi process. The child uses the configured EnMaaS provider directly. It does not use `router/auto`. OpenAI models use the Responses API from the EnMaaS catalog. No model fallback occurs. A failure returns an error.

The parent allows four concurrent children and eight calls per user prompt. Each child has a 120-second limit and a limit of 20 model turns. The parent stops a child when the user cancels the tool call. The parent returns at most 32,000 characters of the final answer. The result identifies the role and model. Pi receives the token usage reported by the child. The EnMaaS catalog reports zero cost to pi. Use gateway billing data for actual charges.

## Security limits

Child processes share the parent filesystem, network policy, operating-system identity, and EnMaaS credentials. A separate process is not a security sandbox. The tool list limits model actions through pi. It does not protect files that the child can read. The OpenShell policy continues to apply to child processes.

Repository content and subagent output are untrusted data. The parent must verify findings before it uses them. A different model does not guarantee an independent or correct review. Measure quality against the existing router before you enable automatic delegation.
