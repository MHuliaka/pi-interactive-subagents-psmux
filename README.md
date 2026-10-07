# pi-interactive-subagents

Async subagents for [pi](https://github.com/badlogic/pi-mono), running in Psmux panes on Windows through its tmux-compatible CLI. Spawn a sub-agent, keep working in the main session, and get the result steered back when it finishes. Fully non-blocking.

**Windows-focused Psmux + Git Bash fork.** It keeps the upstream tmux-based integration model while replacing the native tmux requirement with [Psmux](https://github.com/psmux/psmux) and using Git Bash for POSIX shell compatibility.

See [Acknowledgements](#acknowledgements) for the fork lineage and upstream projects.

## Windows quick start

Install [pi](https://github.com/badlogic/pi-mono), Psmux, and Git for Windows. From PowerShell:

```powershell
winget install psmux
winget install --id Git.Git -e
```

Open a new terminal so PATH picks up the installed executables, then start a Psmux session:

```powershell
psmux new -A -s pi
```

Inside that session, change to this checkout and load the extension:

```powershell
pi -e ./pi-extension/subagents/index.ts
```

The parent session can use PowerShell; the extension explicitly starts Git Bash in child panes. No WSL or native Unix tmux installation is needed.

In pi, run `/subagent-model` to choose models for your agents, then try:

```text
/subagent scout Summarize this project's architecture
```

If pi was already running when the extension changed, use `/reload` first. See [Model configuration](#model-configuration) for persistent settings and precedence.

## How it works

`subagent()` returns immediately. The sub-agent runs in its own Psmux pane — a right split off the parent pi pane, so pane creation never steals keyboard focus. A live widget above the input tracks every running sub-agent, and when one finishes, its result is steered into the main session as a notification that triggers a new turn.

```
╭─ Subagents ──────────────────────────── 2 running ─╮
│ 00:23  scout      active · bash 7m                 │
│ 00:45  scout-2    waiting 2m                       │
╰────────────────────────────────────────────────────╯
```

Spawn several in parallel — they run concurrently and steer results back independently as each finishes.

Panes are kept evenly sized: the extension re-applies an `even-horizontal` layout after every spawn and exit (debounced). The layout is a single constant, `SUBAGENT_PSMUX_LAYOUT` in `pi-extension/subagents/psmux.ts` — change it to any supported named layout (`main-vertical`, `tiled`, …).

If your shell startup is slow and launch commands get dropped before the prompt is ready, raise the delay:

Set the delay before starting pi. From PowerShell:

```powershell
$env:PI_SUBAGENT_SHELL_READY_DELAY_MS = '2500' # default: 500 ms
```

Or from Git Bash:

```bash
export PI_SUBAGENT_SHELL_READY_DELAY_MS=2500
```

## Tools

| Tool | Description |
| --- | --- |
| `subagent` | Spawn a sub-agent in a dedicated Psmux pane (async) |
| `subagent_message` | Message a sub-agent by name — steers it if running, resumes its session if finished |
| `subagents_list` | List available agent definitions |
| `ask_question` | *(sub-agent sessions only)* Ask the orchestrator a question and wait for the reply |

### Commands

| Command | Description |
| --- | --- |
| `/subagent <agent> <task>` | Spawn an agent directly |
| `/subagent-model` | Choose a model and thinking level for one agent or the global default |

### Spawning

```typescript
subagent({ agent: "scout", task: "Analyze the auth module" });
subagent({ agent: "worker", name: "dark-mode", task: "Implement the dark mode toggle" });
```

| Parameter | Type | Default | Description |
| --------- | ---- | ------- | ----------- |
| `agent` | string | required | Which agent to spawn (must be known and permitted) |
| `task` | string | required | Task prompt |
| `name` | string | agent name | Display name for the pane and widget. Must be unique — duplicates are auto-suffixed (`scout`, `scout-2`, …) |
| `model` | string | resolved config/agent model | Override the model for this spawn unless the agent has an authoritative per-agent config pick (see [Model configuration](#model-configuration)) |
| `cwd` | string | agent's `cwd` | Working directory (see [Role folders](#role-folders)) |

### Messaging

`subagent_message` is addressed **by name only**. Names are unique per session and persist after a sub-agent finishes, so the same name works either way:

```typescript
subagent_message({ name: "scout", message: "Also check the auth middleware" });
```

- **Running** — the message is typed into the live pane (newlines flattened) and picked up at the next turn boundary. The call returns immediately; the eventual completion still arrives as a steer message.
- **Finished** — the session is resumed with the message as the follow-up task, like a fresh spawn: fire-and-forget, always autonomous, result steered back later. The resumed run reclaims its original name.

Every spawn records name → session file in `artifacts/<sessionId>/subagent-registry.json`, so names stay addressable across pi restarts. A nested sub-agent that spawns children gets its own registry keyed by its own session id. Resume is refused with a clear error (listing known names) if the name isn't registered, the session file is gone, or the session predates sandboxed resume.

**Resume preserves the original sandbox.** At spawn time the fully-resolved loadout — tool allowlist, backing extensions, model token, thinking level, system prompt, spawn whitelist, cwd — is snapshotted to `<session>.loadout.json`. Resume restores the same tool and extension restrictions rather than relaunching unrestricted. Model and thinking selection are re-resolved against the current config, so changing `/subagent-model` also affects resumed agents; an `inherit` token follows the parent session's active model.

### ask_question

A sub-agent can ask its orchestrator a single freeform question when requirements are ambiguous or a decision materially affects the work. The session **stays open** (parked as `waiting`) instead of exiting; the parent is notified with the sub-agent's name, replies via `subagent_message({ name, message })`, and the reply arrives as the sub-agent's next turn. Parallel questions are supported — each waiting sub-agent has its own name.

If the reply arrives while the sub-agent is still mid-turn, it is absorbed into the current turn — either way the question is marked answered and the session exits normally when the work is done. If the parent never replies, the pane stays open until a human closes it. Only available inside sub-agent sessions.

## Bundled agents

| Agent | Model | Tools | Role |
| ----- | ----- | ----- | ---- |
| **scout** | `openrouter/z-ai/glm-5.3` | `read`, `grep`, `find`, `ls` | Fast read-only codebase recon |
| **researcher** | `openrouter/z-ai/glm-5.3` | `web_search`, `web_fetch`, `safe_bash` | Web research, synthesized into a sourced brief |
| **worker** | `openrouter/z-ai/glm-5.3` | `read`, `write`, `edit`, `bash`, `web_search`, `web_fetch` + spawning | General implementer; may spawn `scout` and `researcher` |

The models above are frontmatter defaults, not fixed requirements. Use `/subagent-model` to select models available in your pi installation without editing the bundled files.

All three are autonomous (`auto-exit: true`) and carry their identity in the system prompt (`system-prompt: append`).

## Custom agents

Place a `.md` file in `.pi/agents/` (project) or `~/.pi/agent/agents/` (global). Discovery priority: **project > global > package-bundled** — a project-local file overrides a bundled agent with the same name.

```markdown
---
name: my-agent
description: Does something specific
model: openrouter/z-ai/glm-5.3
thinking: medium
tools: read, edit, write, safe_bash, web_search
session-mode: lineage-only
auto-exit: true
---

You are a specialized agent that does X...
```

### Frontmatter reference

| Field | Type | Description |
| ----- | ---- | ----------- |
| `name` | string | Agent name (used in `agent: "my-agent"`) |
| `description` | string | Shown in `subagents_list` |
| `model` | string | Default model; config and spawn parameters can take precedence |
| `thinking` | string | Default thinking level; supported levels depend on the model and pi version (see [Model configuration](#model-configuration)) |
| `tools` | string | Strict tool allowlist. Built-ins: `read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`. Extension-backed: `web_search`, `web_fetch`, `safe_bash`, `video_extract`, `youtube_search`, `google_image_search`. Only the extensions backing the listed tools are loaded into the child |
| `subagent_agents` | string | Comma-separated agent names this agent may spawn. **Presence of this field grants the spawning toolset** (`subagent`, `subagent_message`, `subagents_list`) and restricts spawn targets to the list. Omit it and the agent cannot spawn at all |
| `skills` | string | Comma-separated skill names to auto-load |
| `session-mode` | string | `standalone` (default), `lineage-only`, or `fork` — see below |
| `system-prompt` | string | `append` or `replace`: pass the body as the child's `--append-system-prompt` / `--system-prompt`. Omit and the body is prepended to the task prompt instead |
| `auto-exit` | boolean | Auto-shutdown when the agent finishes (see below) |
| `interactive` | boolean | Whether stall/recovery transitions wake the parent (see below) |
| `cwd` | string | Default working directory |
| `disable-model-invocation` | boolean | Hide from `subagents_list`; still spawnable by explicit name |
| `cli` | string | `claude` runs the agent via the Claude Code CLI instead of pi |

### session-mode

- `standalone` — fresh session, no lineage link to the caller (default)
- `lineage-only` — fresh session with `parentSession` linkage for discovery/fork UX, but no copied turns
- `fork` — child session seeded with the caller's conversation context

### auto-exit

With `auto-exit: true`, the session shuts down when the agent's turn ends — the agent just writes its final message and stops (there is no "done" tool). The last assistant message becomes the summary returned to the parent. Recommended for all autonomous agents.

Notes:

- **Manual input does not strand an auto-exit sub-agent.** If a human types into the pane, the session still closes once that turn completes normally — only an escape/abort leaves it open.
- **Auto-exit is suppressed while work is in flight:** the session parks as `waiting` instead of exiting when an `ask_question` is still unanswered, or when the agent's own child sub-agents are still running (a worker can stop after dispatching children and stays open until the last result returns).

### interactive

Controls whether `stalled`/`recovered` status transitions send a steer message to the parent session. Defaults to the inverse of `auto-exit`: autonomous agents get stall pings; user-driven agents stay quiet (the user is already working in that pane — the widget still updates). Set explicitly to override.

## Tool access control

Access is **whitelist-only**. Every sub-agent process is launched with `--no-extensions` (extension discovery disabled) and `--tools <allowlist>`; only the extensions backing the listed tools are loaded back in explicitly. There is no default toolset and no deny-list — an agent gets exactly what its frontmatter lists. The restriction survives resume via the loadout snapshot.

Spawns must name a known agent at **every** depth. A top-level session may spawn anything discoverable; a sub-agent may only spawn the agents in its `subagent_agents` list (enforced via `PI_SUBAGENT_ALLOWED`). There is no agentless spawn route, so a child can never escalate to a full-toolset profile by omitting its agent.

Extensions can register additional tools for sub-agents at runtime via `registerToolExtension(name, path)` on the `__pi_interactive_subagents` process global.

## Role folders

`cwd` starts a sub-agent in a directory with its own config, so role-specific setups (CLAUDE.md, skills, extensions) apply:

```
project/
└── agents/
    ├── game-designer/   ← CLAUDE.md, .pi/…
    └── sre/             ← CLAUDE.md, .pi/…
```

```typescript
subagent({ agent: "worker", cwd: "agents/sre", task: "Review the deployment pipeline" });
```

Set a per-agent default with `cwd:` in frontmatter.

## Model configuration

### Select models interactively

Run `/subagent-model` inside pi:

1. Choose an agent (`scout`, `researcher`, `worker`, or a custom agent), or **all agents (config default)**.
2. Choose an available model, **inherit** to follow the parent session, or **reset to the agent's own model** to remove the selected target's model override.
3. Choose a supported thinking level, leave it unchanged, or reset its override.

Use the arrow keys and Enter to select, type to fuzzy-filter the model list, or press Esc or Ctrl+C to cancel the dialog without exiting pi. Cancellation at the agent, model, or thinking step leaves the saved config unchanged. Model and thinking choices are saved together only after both steps complete.

A reset removes an override; it does not bypass the precedence chain below. For example, clearing an agent's model pick still allows `models.default` to apply. A global default does not replace existing per-agent picks.

The command changes future launches and resumed sessions, not agents that are already running. `subagents_list` reports the resolved model and its source.

### Config file and precedence

A sub-agent model comes from the per-agent `models` entry, the spawn `model` parameter, the `models` default, or the agent frontmatter, in that order. The `models` section is optional. Without it, models come from the agent frontmatter exactly as before. A per-agent entry is authoritative: the parent's `model` parameter cannot silently override the user's `/subagent-model` pick and instead produces a warning.

The config lives at `<agent-dir>/subagents.json`, outside the package checkout, so a package update cannot delete it. On Windows the default is `%USERPROFILE%\.pi\agent\subagents.json`; `PI_CODING_AGENT_DIR` changes the agent directory. The file is created on the first saved selection and can also be edited manually.

Read precedence is the durable `subagents.json`, then a legacy package-root `config.json`, then the shipped `config.json.example`. An effective write migrates legacy settings to the durable location and preserves the status section and unrelated config keys.

```json
{
  "status": { "enabled": true },
  "models": {
    "default": "inherit",
    "thinking": "low",
    "agents": {
      "scout": { "model": "provider/model-id", "thinking": "low" },
      "worker": { "model": "inherit" }
    },
    "validate": true,
    "fallback": "inherit"
  }
}
```

| Key | Type | Default | Meaning |
| --- | ---- | ------- | ------- |
| `default` | string | none | Model for every agent without a per-agent entry. |
| `thinking` | string | none | Thinking level for every agent. One of `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. |
| `agents` | object | `{}` | Per-agent `model` and `thinking` overrides, keyed by agent name. |
| `validate` | boolean | `true` | Check the resolved model against the models this pi installation can run. |
| `fallback` | string | `inherit` | Action when validation fails: `default`, `inherit`, or `fail`. |

Resolution order, first match wins:

| Priority | Source |
| -------- | ------ |
| 1 | `models.agents["<name>"].model`. |
| 2 | The `model` parameter on the spawn call. |
| 3 | `models.default`. |
| 4 | The `model:` field in the agent frontmatter. |
| 5 | The pi session default, when no model applies. |

A value is a `provider/modelId` string, a bare `modelId`, or `inherit`. A recognized thinking suffix such as `provider/modelId:low` is also supported. `inherit` uses the parent session's active model; thinking comes from the per-agent config, global config, or agent frontmatter, falling back to the parent's level when no explicit level is set.

On resume, the current per-agent model pick wins, then the global default, then the token stored in the loadout snapshot. An `inherit` snapshot is resolved against the parent at resume time rather than freezing its original model.

A model that this installation cannot run follows `fallback`. With the default `inherit` the sub-agent still starts and the parent shows a warning. Set `fallback` to `fail` to refuse the spawn instead. Set `validate` to `false` to pass every model through unchanged.

Use `/subagent-model` to pick a model for one agent or for all agents. The picker scrolls with the selected row kept in view, supports fuzzy filtering, and marks the model currently configured for the target. On pi builds that expose scoped models, it lists that set when configured; otherwise it lists the credentialed catalogue. The command writes `<agent-dir>/subagents.json` and keeps the `status` section. `subagents_list` shows the model each agent will use and where it came from.

After the model, `/subagent-model` asks for the thinking level. It offers `leave thinking unchanged` (keep the configured value), `reset to inherited/default` (remove the override so the global or frontmatter level applies), and the levels the chosen model supports. Only the chosen model's supported levels are listed: a model that cannot reason offers only `off`, with a note in the dialog, and `inherit` offers the parent session's model's levels. The target's configured thinking level (or the global configured level) is pre-selected when present in the list, and model and thinking are written in one update.

The config accepts any level for any model, because the model can change later. When a configured level is not supported by the model that actually runs, the effective level is clamped to the nearest supported level and the parent shows a warning; a non-reasoning model resolves to `off`.

## Status widget & configuration

The widget tracks each sub-agent from a runtime activity snapshot written by the child: `starting`, `active` (turn/provider/tool work), `waiting` (open for input or another stage), `stalled` (no valid snapshot for too long), or `running` (fallback). Sub-agent sessions also show their own tools widget — toggle it with `Ctrl+Alt+O`. Completion messages expand with `Ctrl+O`.

Status display and model selection share `<agent-dir>/subagents.json` (default `~/.pi/agent/subagents.json`), created on the first `/subagent-model` write. The package ships `config.json.example` as the default:

```json
{
  "status": { "enabled": true },
  "models": { "agents": {} }
}
```

## Requirements & troubleshooting

- Windows 10/11 with a ConPTY-capable terminal, such as Windows Terminal
- [pi](https://github.com/badlogic/pi-mono), installed and configured with model credentials
- [Psmux](https://github.com/psmux/psmux), available as `psmux.exe` on PATH
- [Git for Windows](https://git-scm.com/downloads/win), providing native Git Bash

This is a **Psmux + Git Bash** implementation, not a native PowerShell rewrite of the child launch scripts. The parent can run in PowerShell; child panes use Bash quoting, environment assignments, and `.sh` scripts. Claude Code agents also need the Claude CLI and `python3` on PATH for the existing Bash completion hook.

### Custom Git installation

Set the native Bash executable before starting pi:

```powershell
$env:PI_BASH_PATH = 'C:\Program Files\Git\bin\bash.exe'
```

Use Git Bash, not the legacy `C:\Windows\System32\bash.exe` WSL launcher.

### Common issues

- **`psmux` is not found:** open a new terminal after installation and check `where.exe psmux` and `psmux --version`.
- **Subagents require Psmux:** start pi inside `psmux new -A -s pi`. Detection uses `PSMUX_SESSION` and the tmux-compatible `TMUX_PANE` environment variable.
- **Launch input is dropped:** increase `PI_SUBAGENT_SHELL_READY_DELAY_MS` before starting pi (see [How it works](#how-it-works)).
- **There is no room for a pane:** enlarge the terminal or close unused panes. The extension rejects a split that reports the existing parent pane rather than treating it as a child.
- **A configured model is unavailable:** use `/subagent-model` to choose a credentialed model, or adjust `models.fallback`. Restricted agents load only their tool-backing extensions; a model backed by a custom provider extension may require additional integration.

## Development & tests

From the checkout, run:

```powershell
npm ci
npm test
```

Unit tests cover model configuration, picker behavior, persistence, sandbox/resume resolution, and mocked Psmux operations without making LLM calls.

To test actual panes, run this inside a Psmux session:

```powershell
node --test test/integration/psmux-surface.test.ts
```

The full `npm run test:integration` suite also runs subagent lifecycle tests with **real, paid LLM calls**. Integration suites do not exercise panes when run outside Psmux.

## Acknowledgements

Forked from [amosblomqvist/pi-interactive-subagents](https://github.com/amosblomqvist/pi-interactive-subagents).

That project is itself based on [HazAT/pi-interactive-subagents](https://github.com/HazAT/pi-interactive-subagents), which originated the subagent architecture, multi-multiplexer surface layer, and status widget; its supervision features were inspired by [RepoPrompt](https://repoprompt.com/).

This fork adds native Windows support using [Psmux](https://github.com/psmux/psmux) as a tmux-compatible terminal multiplexer together with Git Bash for POSIX shell compatibility.

Model selection configuration and the picker were ported from [PR #14](https://github.com/amosblomqvist/pi-interactive-subagents/pull/14) by [T-NhanNguyen](https://github.com/T-NhanNguyen), with compatibility adaptations for this fork.

## License

MIT
