# Pi Extensions

Personal pi extension package for Lachlan's local coding-agent workflow. It bundles trusted-machine integrations, UI chrome, and agent tools that intentionally optimize for this machine rather than public distribution.

## Language

**Pi Extension Package**:
A locally installed package that adds pi tools, commands, themes, and UI behavior to the coding agent.
_Avoid_: Public plugin, marketplace extension

**Local Package Identity**:
The package name and README framing that should describe the full local bundle rather than one integration; canonical package name is `lachlan-aa-pi-extensions`.
_Avoid_: Browser-only package name, public package brand

**Trusted Machine**:
The single local environment where these extensions run with full system permissions and may use hard-coded local defaults.
_Avoid_: User environment, customer machine

**Trusted Team Workflow**:
A workflow used by Lachlan or explicitly trusted collaborators where local credentials, dashboards, and project defaults may be assumed.
_Avoid_: Multi-tenant workflow, public workflow

**Workflow Compression**:
The main value of the package: reducing repeated local operational work into reliable pi tools, commands, and UI affordances.
_Avoid_: Generic extensibility, public plugin ecosystem

**Agent Leverage**:
The secondary value of the package: giving the coding agent dependable tools that let it complete trusted workflows with less manual steering.
_Avoid_: Autonomous operation, unrestricted automation

**Integration Module**:
A focused extension entrypoint for one workflow surface such as browser automation, Fallow codebase intelligence, Linear, Supabase, roo, GitHub review, Watchtower incoming-change monitoring, or Vice City chrome.
_Avoid_: Plugin subsystem, framework layer

**Free Browser Automation**:
Browser automation that the agent may use without confirmation prompts because the package runs only on the Trusted Machine.
_Avoid_: Permission-gated browser automation, read-only browser mode

**Curated Browser Wrapper**:
A browser tool surface that exposes common actions as typed tools and keeps a raw command escape hatch for uncommon agent-browser features.
_Avoid_: Complete CLI reimplementation, minimal-only browser wrapper

**Browser Command Escape Hatch**:
A browser tool that accepts structured agent-browser CLI arguments, prepends the active CDP port, truncates output, and refreshes browser state.
_Avoid_: Shell-based browser command, unrestricted executable runner

**User-Directed Linear Automation**:
Linear issue search, creation, updates, and comments performed only when the user asks the agent to check or change something in Linear.
_Avoid_: Free Linear automation, unsolicited issue changes

**Read-Only Supabase Access**:
Supabase database access limited to inspection queries so diagnosis can use production-like data without ad-hoc database mutation.
_Avoid_: Database write automation, migration runner

**Fallow Codebase Intelligence**:
Deterministic project-graph analysis for dead code, duplication, complexity, health score, refactor targets, and PR audit gates, exposed through pi tools that default to agent-friendly JSON output.
_Avoid_: Ad-hoc grep cleanup, LLM-only whole-codebase reasoning

**Fallow Safe Cleanup**:
A cleanup workflow where automatic fixes are previewed with dry-run before applying, and Fallow's limited auto-fix scope is respected: unused exports/dependencies are automatic, unused files and refactors remain normal code edits.
_Avoid_: Blind deletion, broad formatter-style mutation

**Strict Roo Gate**:
A bash interception rule that forces likely long-running local processes through roo, accepting false positives to avoid hung agent turns.
_Avoid_: Best-effort process guidance, permissive bash for dev servers

**Review Learning**:
A small append-only rule captured from PR feedback so future review or fix sessions avoid repeating non-obvious mistakes.
_Avoid_: Knowledge base article, repo documentation

**Tripwire Ledger**:
An opt-in supervisor state machine that accumulates deterministic risk flags from tool calls, hard-blocks only critical irreversible actions, and escalates to a model reviewer only when a risk budget is crossed.
_Avoid_: Always-on reviewer, scheduled nag agent

**Watchtower Monitor**:
An opt-in git monitor that fetches and displays incoming target-branch changes only after the user enables it for the session.
_Avoid_: Always-on incoming-change monitor, background git fetcher

**Fun Chrome**:
Optional visual and audio ambience that makes pi feel personal without shaping core tool architecture.
_Avoid_: Productivity primitive, shared UI framework

**Workflow State**:
Session- or branch-scoped state that affects an agent's next action, such as the current browser page or connected Supabase project.
_Avoid_: Global preference, external source of truth

**Ambient Mode State**:
Session-scoped UI or monitoring preference such as Vice City mode or Watchtower enabled state.
_Avoid_: Agent reasoning state, global package config

**External Truth**:
State owned outside pi, such as roo process metadata or Linear issue data, that should be rediscovered instead of persisted as canonical.
_Avoid_: Cached workflow state

**Truncated Tool Output**:
Tool output capped to pi-sized context limits while saving full output to a temporary artifact when useful.
_Avoid_: Unbounded tool output, silent truncation

**Human Command**:
A slash command optimized for quick human-triggered workflows in pi.
_Avoid_: Agent primitive

**Agent Tool**:
A callable capability intended for the coding agent to execute workflow steps directly.
_Avoid_: Human-only shortcut

**Light Guard Test**:
A small unit test around pure safety or parsing logic where regressions would be annoying and integration setup is unnecessary.
_Avoid_: Full integration test suite, mocked SaaS test harness

**Recoverable Prerequisite Failure**:
A missing local CLI, token, browser port, or app state that should produce a concrete next step instead of vague failure.
_Avoid_: Silent startup failure, generic command failed

**Trusted Secret Handling**:
A lightweight local-token posture where tools avoid intentionally printing secrets, without adding broad redaction machinery.
_Avoid_: Secret management platform, transcript sanitizer

## Relationships

- A **Pi Extension Package** has a **Local Package Identity** that reflects the whole local bundle.
- A **Pi Extension Package** runs on the **Trusted Machine**.
- A **Pi Extension Package** supports one or more **Trusted Team Workflows**.
- A **Trusted Team Workflow** may rely on hard-coded local defaults when they reduce friction.
- **Workflow Compression** is prioritized over **Agent Leverage**, and **Agent Leverage** is prioritized over visual polish.
- A **Pi Extension Package** is composed of **Integration Modules**, with shared helpers introduced only when repetition is concrete.
- **Fallow Codebase Intelligence** complements agent file reading with deterministic whole-codebase analysis for cleanup, refactoring, and PR gates.
- **Fallow Safe Cleanup** requires dry-run preview before automatic cleanup is applied; Fallow fix output should guide but not replace normal review for unused files and refactors.
- **Free Browser Automation** is allowed for trusted dashboard workflows; browser mutations do not require confirmation prompts.
- A **Curated Browser Wrapper** should cover common browser actions with typed tools and provide a raw escape hatch for rare agent-browser commands.
- A **Browser Command Escape Hatch** uses an argument array, not a shell command string, and always targets the active browser CDP port.
- Typed browser additions should prioritize press, scroll, wait, navigation, information extraction, and debug output; rarer commands stay behind the escape hatch.
- **User-Directed Linear Automation** is allowed; Linear actions need a user request to check or change Linear, but do not need extra confirmation prompts after that request.
- **Read-Only Supabase Access** supports diagnosis; database writes belong in application code or migrations, not ad-hoc tools.
- The Supabase read-only boundary is pragmatic: lexical DML/DDL blocking is acceptable for the Trusted Machine, even though PostgreSQL side-effect functions cannot be perfectly detected.
- A **Strict Roo Gate** blocks likely long-running bash commands; false positives are acceptable because roo is safer for inspectable processes.
- **Review Learnings** stay append-only and are injected only into explicit review/learning workflows.
- A **Tripwire Ledger** should stay opt-in, branch-scoped, low-noise, deterministic-first, and visible through pi-native TUI surfaces; model review is exception-only after risk budget crossing.
- The **Watchtower Monitor** remains user-enabled rather than always-on.
- **Fun Chrome** stays isolated from core workflow tools and should not drive package architecture.
- **Workflow State** is session/branch scoped, **Ambient Mode State** is session scoped, **External Truth** is rediscovered, and **Review Learnings** are global memory.
- Long tool outputs should become **Truncated Tool Output** with visible full-output artifact paths.
- Fallow tools should default to JSON output for agent workflows and save/truncate large reports rather than forcing human parsing.
- **Human Commands** should trigger user-facing workflows; **Agent Tools** should expose workflow primitives the agent can safely execute.
- Testing should stay limited to **Light Guard Tests** for pure helpers such as SQL read-only checks, roo command detection, argument compatibility, and state serialization.
- A **Recoverable Prerequisite Failure** should explain the missing prerequisite and the next command or setup step when possible.
- **Trusted Secret Handling** means do not include token values in status, diagnostics, or expected errors; broad output redaction is not required.

## Example dialogue

> **Dev:** "Should the Supabase helper require explicit project selection every time?"
> **Domain expert:** "No — this is a **Trusted Machine** package, so a hard-coded default project is acceptable when it speeds up the **Trusted Team Workflow**."

## Flagged ambiguities

- "Well-designed" does not mean public/general-purpose; resolved: design for a personal/trusted-team package that will not leave this machine.
- "Thoughtful implementation" means prioritizing **Workflow Compression** first, **Agent Leverage** second, and visual polish third.
- "Platform core" was considered but rejected; resolved: keep **Integration Modules** independent and avoid a generic framework layer.
- Browser automation safety ambiguity resolved: browser tools are **Free Browser Automation**, not permission-gated tools.
- Browser surface ambiguity resolved: use a **Curated Browser Wrapper** rather than wrapping every agent-browser command one-by-one.
- Linear automation safety ambiguity resolved: Linear actions are **User-Directed Linear Automation**; the agent must be asked to check or change Linear, but should not add extra confirmation prompts once asked.
- Supabase automation boundary resolved: keep **Read-Only Supabase Access**; do not add database write tools.
- Process-management ambiguity resolved: keep a **Strict Roo Gate** for local dev servers/watchers/tunnels, while leaving Docker/Podman to native lifecycle commands.
