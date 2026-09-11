---
name: jira
description: Work with Jira issues through jira-cli against the instance of the current context (Data Center or Cloud). Use for /jira, "show issue PROJ-123", "my open issues", "create a ticket", "move to In Progress", "comment on the issue", or any Jira key like ABC-42.
---

`jira` on PATH is an exe shim. It runs jira-cli with the config and token of the current directory's context, so the same command works against jira.uzinfocom.uz in one repo and bepro-devhub.atlassian.net in another. No flags, no tokens.

## Recipes

Keep output small. Always use `--plain`, pick columns, and paginate.

| Ask | Run |
|---|---|
| issue summary | `jira issue view KEY --plain --comments 0` |
| issue with last comments | `jira issue view KEY --plain --comments 3` |
| my open issues | `jira issue list -a$(jira me) -s~Done --plain --columns key,status,summary --paginate 0:20` |
| issues by JQL | `jira issue list -q 'project = PROJ AND sprint in openSprints()' --plain --columns key,assignee,status,summary --paginate 0:30` |
| create | `jira issue create -tTask -s"Title" -b"Body" --no-input` (add `-pPROJ` when the context has no default project) |
| transition | `jira issue move KEY "In Progress"` |
| assign to me | `jira issue assign KEY $(jira me)` |
| comment | `jira issue comment add KEY "text" --no-input` |
| link branch to key | the key in the branch name, e.g. `feature/PROJ-123-login`, matches `[A-Z][A-Z0-9]+-[0-9]+` |
| raw JSON when a field is needed | `jira issue view KEY --raw` then read only the field, never paste the whole document |

## Rules

- Infer the issue key from the current branch name when the user does not give one; confirm it in the reply.
- Use the context's default project from `exe ctx show`; pass `-p` only when the user names another project.
- Before `create`, `move`, `assign` or `comment`, show the exact command and wait unless the user already asked for it explicitly.
- If jira-cli reports a missing token or config, run `exe doctor --context <name>` and report the failing line. Do not ask the user to paste a token; point them to `exe secret set jira-<context>`.
- A full setup with issue types and boards, needed for some `create` fields, is `jira init --config ~/.config/exe/jira/<context>.yml --force` run by the user in their terminal.
