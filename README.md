# Pi Interactive Subagents

Run isolated Pi agents concurrently and view their conversations **inside the main terminal tab**. No terminal multiplexer, extra tabs, PowerShell, or shell launch scripts are required.

Requires **Pi 1.1+** (`@earendil-works/pi-coding-agent`) and a `pi` executable on `PATH`. The extension assumes `spawn("pi", args)` works on the host. Its backend uses Node processes, filesystem APIs, and Pi's JSONL RPC protocol on Windows, macOS, and Linux. An agent's own shell commands still depend on the tools available on that OS.

## Load

From this directory:

```sh
npm install
pi --extension ./pi-extension/subagents/index.ts
```

If the package is already installed in Pi, update its checkout, install its dependencies, then run `/reload` in Pi. Existing Psmux tabs from the previous version are not managed by this version; finish or close them before reloading.

## Main tab and subagent views

The main conversation has a blue **Subagents** block. It shows up to five recent agents so a large delegation doesn't fill the terminal. All agents are accessible through the selector.

- Click a row in the block to open that agent in **fullscreen terminal mode**.
- Use **Ctrl+Shift+G** or `/subagents` to select an agent with the keyboard.
- Use `/subagents <name>` to open a particular agent directly.

Opening an agent covers the terminal with its conversation, streaming response, thinking, tool arguments/results, usage, and message input. The main session remains active underneath, with its history and editor untouched. Other agents continue running.

The same blue border contains **← Return to main agent**.

| Control in subagent view | Action |
| --- | --- |
| Click **Return to main agent**, or press **Esc** | Return without stopping the child |
| **Ctrl+Shift+G** | Return to main |
| **Enter** | Send input to this child, not the main agent |
| **Shift+Enter** | Insert a newline; multiline paste is also supported |
| **PgUp / PgDn**, mouse wheel | Scroll conversation |
| **Ctrl+Home / Ctrl+End** | Oldest output / follow live output |
| **Ctrl+C**, **Ctrl+D**, or submit `/exit` | Stop this child and return to main |

**When the selected child settles, fails, or exits, the view automatically returns to main.** Stopping one child does not abort the main agent or any sibling. Returning manually retains an unsent child draft for the next visit. Completed conversations remain available to inspect.

Mouse interaction is supported by Pi's fullscreen mode. Keyboard navigation also works in regular mode. Images are represented by placeholders; this is a structured conversation viewer, not an embedded child terminal or a clone of every native Pi screen.

### Commands

```text
/subagent worker Fix the failing tests
/subagents
/subagents worker
/subagent-stop worker
/subagent-model
```

`/subagent-model` retains the searchable model picker and thinking-level selection. `/subagent-stop <name>` stops an agent without needing to enter its view.

## Agent tools

The main agent receives:

- **subagent** — launch a profile in the background. `agent` chooses the profile; `name` is an optional unique follow-up handle. `task` is required. Optional `model` and `cwd` overrides are supported.
- **subagent_message** — send a follow-up to a live child or resume a finished child by name with its saved conversation and tool loadout.
- **subagents_list** — list available profiles, effective models, and session statuses. Results arrive automatically; polling is unnecessary.

Example:

```text
subagent({ agent: "scout", name: "recon", task: "Find the code handling login" })
subagent_message({ name: "recon", message: "Also inspect logout" })
```

Names without an explicit `name` are deduplicated (`scout`, `scout-2`, …). Explicit names cannot overwrite an existing conversation; use `subagent_message` to continue it.

Results are delivered to the parent as steer messages. Children can use **ask_question** to request a decision. The parent receives the question and replies through `subagent_message`; the child stays alive while waiting. Child extension dialogs (select, confirm, input, editor) are forwarded to the parent UI, returning to main before showing the dialog. Parallel dialogs are serialized, and a child's stop, crash, or dialog timeout cancels its dialog so it cannot strand the main editor.

## Agent profiles

Profiles are Markdown files with frontmatter. Discovery order, from lowest to highest priority:

1. Bundled `agents/`
2. `<Pi agent directory>/agents/` (normally `~/.pi/agent/agents/`)
3. Project `.pi/agents/`

Example:

```markdown
---
name: reviewer
description: Read-only code reviewer
tools: read, grep, find, ls
model: inherit
thinking: medium
system-prompt: append
auto-exit: true
session-mode: standalone
---

Review the assigned code and return actionable findings.
```

Supported fields:

| Field | Meaning |
| --- | --- |
| `name`, `description` | Profile identity and discovery description |
| `tools` | Comma-separated tool allowlist |
| `model`, `thinking` | Defaults; model config can override them |
| `system-prompt: append` / `replace` | Apply the Markdown body as a system prompt; otherwise include it in the task |
| `auto-exit` | Defaults to true; end the background process after the task settles |
| `session-mode` | `standalone` (default), `lineage-only`, or `fork` |
| `cwd` | Working directory; relative profile paths resolve from the Pi agent directory |
| `skills` or `skill` | Comma-separated skill names; load instructions from the child's resource catalogue into the initial task |
| `subagent_agents` | Profiles this child may delegate to; grants the spawning tools |
| `disable-model-invocation: true` | Manual launch through `/subagent` only |

`lineage-only` links to the parent without copying conversation. `fork` copies the active branch before the current dispatching user turn, avoiding unfinished dispatch tool calls. Fork modes require a saved parent session.

With `auto-exit: false`, a settled child returns the view to main but remains idle in the background, ready for another message. Stop it explicitly when finished. Auto-exiting parents wait for their own nested subagents and unanswered questions rather than terminating prematurely.

The bundled profiles may require separately installed tools such as `web_search` or `web_fetch`. Install those extensions or remove the tools from your local profile. Override bundled models with `/subagent-model` if they are not available in your account.

### Tool loadouts

Restricted children disable extension discovery and MCP, then explicitly reload extensions backing their allowlisted tools. `codemode`, `tool_search`, `safe_bash`, and the spawning/control tools have built-in mappings. Custom tool extensions can register their paths:

```typescript
(globalThis as any).__pi_interactive_subagents.registerToolExtension(
  "my_tool",
  "/absolute/path/to/my-extension.ts",
);
```

The same snapshot is replayed on resume. A missing or malformed snapshot is refused rather than silently launching an unrestricted child. A custom model provider supplied by an extension may also need to be explicitly loaded in the child; a tool whitelist alone does not discover provider-only extensions.

## Model configuration

Selections are stored in `<Pi agent directory>/subagents.json`, respecting `PI_CODING_AGENT_DIR`:

```json
{
  "models": {
    "default": "inherit",
    "thinking": "medium",
    "agents": {
      "scout": { "model": "inherit", "thinking": "low" }
    },
    "validate": true,
    "fallback": "inherit"
  }
}
```

Resolution: per-agent config → explicit spawn model → global config default → profile model. `inherit` follows the parent's active model, including on resume. Thinking levels are clamped to model capabilities when validation is enabled. Fallback policies are `inherit`, `default`, or `fail`.

Without a `models` section, profile defaults are preserved. The old package-root `config.json` is still readable for migration; new selections are written to the durable agent directory. Legacy `status` settings are no longer used.

## Process and exit lifecycle

Children start with `pi --mode rpc` using direct argument arrays, `cwd`, and environment variables, never a shell command. Tasks and subsequent messages go over stdin; stdout carries structured events. Stderr is retained for crash diagnostics.

Completion waits for **agent_settled**, not `agent_end`, because retries, compaction, and queued work can continue after an agent run ends. On normal completion the child stdin closes so Pi can flush its session and shut down. Cancellation clears queued work before aborting, then closes stdin. A bounded kill fallback handles unresponsive processes.

Shutdown, session replacement, and `/reload` close the selected view, dispose its input listeners, and stop owned background children. No result is sent into a disposed parent session. Session files, loadout snapshots, and name registries persist, so finished conversations can be inspected or resumed after restart.

## Migration from the Psmux version

This is a breaking backend/UI change:

- Psmux integration, screen polling, launch scripts, activity/sentinel sidecars, and shell hooks were removed.
- `cli: claude` is no longer supported; use a Pi profile instead.
- `interactive` frontmatter and old status/stall-ping settings are no longer used.
- Use the new `@earendil-works` Pi packages, not the older `@mariozechner` runtime.
- Existing Pi session/loadout/name-registry files remain usable. Existing legacy live tabs cannot be reattached.

## Development and verification

```sh
npm test
npm run test:integration
npm run typecheck
```

Tests use Node's TypeScript transform support. Unit tests cover RPC framing, failures, shutdown, streamed messages, nested-child/question waiting, model configuration, persistence, and UI navigation. Integration tests launch real subprocesses implementing a deterministic Pi RPC fixture, exercising concurrency, resume, questions, crashes, and selected-child cancellation without provider credentials. A separate smoke test loads the extension in the real Pi RPC runtime, checks its commands, and verifies clean shutdown without making a model call.

The fixture tests are not a substitute for a manual live-provider/terminal check on each supported OS.
