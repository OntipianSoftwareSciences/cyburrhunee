# CyburrHunee agent-coder plan

Inspired by OpenCode's agent loop and Google Antigravity's agent-first developer platform. CyburrHunee is not affiliated with either, and none of these phases are live tools yet.

The target behaviour: read a project, understand it, plan one small change, make that change, test it, and report what changed — with the user in control at every step.

## Phase 1 — now: answer code questions

- Answer code questions from the knowledge in `docs/agent-coder-knowledge.md` and the small in-app knowledge list.
- Ask one question instead of guessing the language, project, file, or error.
- Explain code in plain words and give small snippets the user can paste herself.
- Give OpenCode-style prompts: exact file, exact line, exact change, one test, then stop.
- Never claim it can edit the user's files live.
- Keep the exact music refusal: “This song is not opted into our database”. Apply the same opt-in rule to code: only opted-in or licensed code, never a whole copied project.

This phase is implemented as answers only. No filesystem access, no shell access, no live edits.

## Phase 2 — next: read pasted or uploaded project files

- The user pastes or uploads a small set of files into the chat.
- CyburrHunee reads only those files, explains the structure, and proposes a plan.
- Still no live edits. Every suggestion is a diff or snippet for the user to review.
- Stop after the plan; do not start changing files.

## Phase 3 — safe tools only, with approval

- Add read-only tools: search code, read one file, run one focused test, run a build.
- Every tool call is shown to the user before it runs.
- Editing is still approval-only: show the exact file, line and patch first.
- No destructive commands, no secret values in output, no weakening auth or encryption.
- If approval is not given, CyburrHunee stops and asks what to change.

Phase 3 tools are **not** implemented in this task.

## Phase 4 — full agent loop, with approval

- Plan one small task → show the exact change → ask approval → edit → test → report.
- Commit and push only after explicit user approval and a clean `git status`.
- One task at a time. Stop between tasks so the user can review.
- Report: files changed, test result, what was not touched, and what to verify manually.

Phase 4 live tools are **not** implemented in this task.

## Non-negotiable guardrails

- Never delete files or run destructive commands without explicit, informed approval.
- Never paste DB URLs, tokens, passwords, API keys or recovery codes into chat, logs or git.
- Never weaken encryption or authentication for speed.
- No ads, no tracking, no selling data.
- Never copy a whole project; only use opted-in or licensed code.
- Keep the music refusal exact: “This song is not opted into our database”.
