# Claude Code Instructions

See [`AGENTS.md`](AGENTS.md) for this repository's agent instructions — issue tracking, where
durable cross-session knowledge lives, and pointers to the rest of the docs. It applies to Claude
Code the same as any other agent.

## Handling a batch of issues with an agent team

When the owner hands over a list of issue numbers to handle in parallel, follow
[`docs/memories/2026-08-26-orchestrating-issue-agent-teams.md`](docs/memories/2026-08-26-orchestrating-issue-agent-teams.md):
triage by component and pick a model per issue, write the shared brief from the template in that
file, launch agents with `isolation: "worktree"` no more than four at a time, have them open PRs
(never merge) and return ≤12-line reports, recheck mergeability after every owner merge, send
conflicts back to the agent that owns the branch, remove the worktrees when everything is
merged, and write a pass-along.
