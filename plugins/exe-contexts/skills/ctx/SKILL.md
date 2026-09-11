---
name: ctx
description: Show, switch or check the exe context (which Jira, GitLab and git identity apply to this repo). Use for /ctx, "which context", "switch context", "use the devhub account", "exe doctor", or when a Jira or GitLab command hits the wrong server.
---

The exe context of a directory decides which Jira instance, GitLab host, Figma account and git identity apply. It is picked from `EXE_CONTEXT`, then `.exe.json` at the git root, then the host of the `origin` remote, then the profiles default. The `exe` command is on PATH inside this session.

## Commands

| Ask | Run |
|---|---|
| current context and why | `exe ctx show` |
| all contexts | `exe ctx list` |
| pin this repo to a context | `exe ctx use <name>` (writes `.exe.json` at the git root; commit it if the team shares it) |
| check tools, proxy and every token | `exe doctor` (add `--context <name>` for one) |
| create the profiles file | `exe ctx init`, then the user edits `~/.config/exe/profiles.json` |
| write git identities and jira-cli configs from the profiles | `exe setup all` |
| store a token | `exe secret set <name>` (prompts; never paste tokens into chat) |

## Rules

- `jira` and `glab` already receive the right token per directory through shims. Do not export tokens, do not run `env` or `printenv`, and never print a token.
- If `exe ctx show` fails with "no profiles", tell the user to run `exe ctx init` and edit the file. Do not invent profile contents.
- After `exe ctx use`, no restart is needed; the next `jira` or `glab` call picks the new context.
- Report doctor output as is. Lines start with `ok`, `warn` or `fail`.
