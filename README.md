# Pi Interactive Subagents

Run isolated Pi agents concurrently and view their conversations **inside the main terminal tab**. No terminal multiplexer or extra tabs are required.

Requires a **JavaScript installation of Pi 1.1+** (`@earendil-works/pi-coding-agent`).

## Load

From this directory:

```sh
npm install
pi --extension ./pi-extension/subagents/index.ts
```

If the package is already installed in Pi, update its checkout, install its dependencies, then run `/reload` in Pi.

## Main tab and subagent views

The main conversation has a blue **Subagents** block. It shows up to five recent active agents so a large delegation doesn't fill the terminal. Rows align names, profiles, states, activity, and elapsed time into columns using whitespace, without extra separators. Hierarchy arrows and indentation stay intact; long names end in `...` when space is limited. Finished agents leave the block, and the block disappears when no agents remain active. Saved/finished conversations are still accessible through `/subagents` for inspection or follow-up.

- Click a row in the block to open that agent in **fullscreen terminal mode**.
- Use **Ctrl+Alt+G** or `/subagents` to select an agent with the keyboard.
- Use `/subagents <name>` to open a particular agent directly.

Opening an agent covers the terminal with Pi's native user, assistant/thinking, tool execution/result, custom-message, and summary components, plus the native editor. Tool output uses Pi's compact previews, syntax highlighting, diffs, image settings, and expansion behavior—not JSON dumps or a separate transcript theme. A native animated loader shows starting, working, thinking, tool execution, retries, compaction, or waiting for child agents—even between output events. It stops when waiting for your answer, idle, finished, or when you leave the view. The main session remains active underneath, with its history and editor untouched. Other agents continue running.

The same blue border contains **← Return to main agent**.

| Control in subagent view | Action |
| --- | --- |
| Click **Return to main agent**, or press **Esc** | Return without stopping the child |
| **Ctrl+Alt+G** | Return to main |
| **Enter** | Send input to this child, not the main agent |
| **Shift+Enter** | Insert a newline; multiline paste is also supported |
| **PgUp / PgDn**, mouse wheel | Scroll conversation |
| **Ctrl+Home / Ctrl+End** | Oldest output / follow live output |
| Pi's tool-expansion key (normally **Ctrl+O**) | Expand/collapse native tool output |
| Pi's thinking-toggle key (normally **Ctrl+T**) | Show/hide native thinking blocks |
| Click thinking or tool results | Use the native component's collapse/expansion behavior |
| **Ctrl+C**, **Ctrl+D**, or submit `/exit` | Stop this child and its descendants, and return to main |

**When the selected child settles, fails, or exits, the view automatically returns to main.** Stopping one child also stops its descendants, but does not abort the main agent or any sibling. Returning manually retains an unsent child draft for the next visit. Completed conversations remain available to inspect.

### Nested agents and errors

The root selector includes the entire agent tree, not just direct children. Descendants have indented rows and unambiguous path handles, such as `worker/recon` or `worker/reviewer/scout`. Use those full handles with `/subagents`, `/subagent-stop`, and `subagent_message`. New local names cannot contain slashes or control characters.

Every conversation uses the same fullscreen view and **Return to main agent** always returns to the root main session, never an intermediate parent. Messages and dialogs route through the owning processes; task results still go to the agent that delegated the task.

- A parent finishing its own turn stays alive while its children work. This does not close a view of a busy descendant.
- Stopping an ancestor closes descendant views immediately and cancels that branch. Siblings continue.
- An ancestor crashing closes descendant views and cleans up known orphan processes. Children also abort/shut down if their parent IPC connection disappears.
- Recoverable tool failures, provider retry attempts, compaction errors, and child extension diagnostics stay inside the child. They neither dismiss its view nor create main-chat/context messages. Successful recovery produces only the final result.
- A terminal child failure returns to main and reports once in a blue frame with an **Error** heading; it does not also send a duplicate result. Terminal failures remain available to the delegating agent. Legacy `subagent_error` messages without terminal-failure metadata are excluded from future orchestrator context, without deleting saved history.
- Viewer/dialog/control failures restore the main UI and show a blue error notification through non-context custom session entries, not `sendMessage()`.
- Finished descendants retain their saved sessions and loadouts. Resuming one from the root starts it as a directly owned background agent; it does not revive a dead ancestor.

Mouse interaction is supported by Pi's fullscreen mode. Keyboard navigation also works in regular mode. Tool images follow Pi's native terminal-capability and image settings. The only extension-specific conversation decoration is the blue subagent information/return block.

Main-chat subagent results appear as compact blue cards, collapsed by default. Subagent questions use gray-background cards, also collapsed by default; their full text still reaches the delegating agent. Click a card to expand/collapse it, or use Pi's tool-expansion shortcut (normally **Ctrl+O**). Terminal failures use blue frames with an **Error** heading and visible failure details.

The active-subagent widget has no bottom shortcut/count hint. It is registered once while agents are active, rather than replaced on every stream update. It stays first in the above-editor widget area without an extra blank row below the blue frame, keeping observation-memory progress underneath instead of swapping positions during updates.

### Model-context boundary

Only these extension-generated messages go to the **delegating agent's** model context:

- Tool-call acknowledgements/results for its own `subagent`, `subagent_message`, or explicitly requested `subagents_list` calls.
- Final results/cancellation status, questions requiring a reply, and terminal failures from agents it owns.

Streaming text, thinking, child tool arguments/results, retry diagnostics, widget updates, dialogs, usage statistics, and navigation do not get copied into main context. The root can display descendant results/questions/failures, but those are non-context `subagent_ui` session entries; the descendant's actual owner receives its model-facing notification. Message `details` (session paths, stats, ownership metadata) are not included in Pi's LLM conversion of custom messages.

Legacy internal-error and duplicate descendant notifications are filtered before normal model requests, compaction, and branch summaries. Saved history is not deleted. Previously generated compaction summaries or observations may already contain old diagnostics; this cannot be safely reversed by a message filter. Third-party extensions that independently summarize raw saved entries must honor the same non-context boundary themselves.

### Native rendering and layout extensions

The view uses Pi's actual `UserMessageComponent`, `AssistantMessageComponent`, `ToolExecutionComponent`, summary/custom-message components, native dialogs, and `CustomEditor`. It reuses the main session's live tool-renderer resolution, Markdown transformers, custom-message/entry renderers, theme, and custom editor factory. A presentation extension loaded in the main Pi session therefore also affects subagent conversations; no extension factories are run again merely to obtain renderers.

Task extensions still execute in the child with its saved profile/tool permissions. This does **not** turn restricted children into unrestricted sessions or enable automatic extension/MCP discovery. Renderer code loaded **only** in an isolated child cannot be transferred through JSON RPC; load its presentation extension in the main session too. Arbitrary child `ctx.ui.custom()` terminal screens and independent child headers/footers/widgets are not supported by Pi's RPC UI protocol and are not mirrored into this view.

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

## Sessions and lifecycle

Agents run as isolated background processes. Conversation updates and controls are routed separately from the main agent's model context; viewing a child does not copy its transcript into the main conversation.

Completion waits for **agent_settled**, not `agent_end`, because retries, compaction, and queued work can continue after an agent run ends. On normal completion the child stdin closes so Pi can flush its session and shut down. Cancellation clears queued work before aborting, then closes stdin. A bounded kill fallback handles unresponsive processes.

Shutdown, session replacement, and `/reload` close the selected view, dispose its input listeners, and stop owned background children. No result is sent into a disposed parent session. Session files, loadout snapshots, and name registries persist, so finished conversations can be inspected or resumed after restart.

## Development and verification

```sh
npm test
npm run test:integration
npm run typecheck
```

Unit and integration tests cover streaming, nested delegation, cancellation/crashes, dialogs, saved sessions, resume, native rendering, and model-context isolation. Real Pi-runtime tests verify extension loading and that UI-only notifications do not enter model messages, without provider credentials.

Automated tests are not a substitute for a manual live-provider and interactive-terminal check.

## Changes from the original project

### New in this version

- **In-tab conversations:** background RPC agents replace separate multiplexer tabs and terminal screen polling.
- **Native Pi presentation:** user/assistant messages, thinking, tools, diffs, images, editors, and dialogs use Pi's built-in components and shared presentation extensions.
- **Blue agent navigation:** an active-only widget opens full-window child conversations; Return always goes to the root main session without stopping the child.
- **Full nested-agent tree:** descendants are visible and addressable by path, with routed messages/dialogs, branch cancellation, and ancestor-crash cleanup.
- **Cleaner notifications:** collapsed blue result cards, collapsed gray question cards, and blue terminal-failure frames. Recoverable child errors stay in the child.
- **Model-context isolation:** UI state and duplicate descendant notifications stay out of main context; legacy diagnostics are filtered before requests and summaries.
- **Stable progress layout:** animated working indicators and a stable agent widget leave room for observation progress below it.
- **Lifecycle regression coverage:** deterministic subprocess tests and real Pi-runtime checks cover the new backend and rendering/context boundaries.

### Retained from the original

Agent profiles, tool permissions, named delegation and follow-ups, model/thinking selection, questions to the delegating agent, saved conversations, and resume remain available.

### Compatibility changes

- Uses the current `@earendil-works` Pi packages.
- Pi-only agent profiles; the previous Claude integration was removed.
- Legacy `interactive`, status, and stall-ping settings are no longer used.
- Existing saved Pi sessions/loadouts/name registries remain usable, but old live multiplexer tabs cannot be reattached.
