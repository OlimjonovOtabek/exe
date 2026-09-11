---
name: gitlab
description: Work with GitLab merge requests, pipelines and issues through glab against the host of the current repo (gitlab.com or self-managed). Use for /gitlab, /mr, "open an MR", "list my merge requests", "pipeline status", "why did CI fail", "review MR !42", or GitLab issues.
---

`glab` on PATH is an exe shim. It runs glab with the token of the current directory's context, and glab itself reads the host from the `origin` remote. The same command works on gitlab.com, git.devhub.uz and gitlab.uzinfocom.uz.

## Recipes

Keep output small: `--per-page`, `-F json` with a field list, and never dump a full pipeline log.

| Ask | Run |
|---|---|
| my open MRs | `glab mr list --author=@me --per-page 20` |
| MRs to review | `glab mr list --reviewer=@me --per-page 20` |
| MR details | `glab mr view 42` |
| MR diff, bounded | `glab mr diff 42 \| head -400` |
| create MR from current branch | `glab mr create --fill --yes` (add `--draft`, `--reviewer user`, `--label x`) |
| approve / merge | `glab mr approve 42`, `glab mr merge 42 --squash --remove-source-branch --yes` |
| pipeline status of this branch | `glab ci status --live=false` |
| pipelines list | `glab ci list --per-page 10` |
| failed job log, bounded | `glab ci trace <job-id> \| tail -120` |
| issues | `glab issue list --assignee=@me --per-page 20`, `glab issue view 7` |
| repo in browser url | `glab repo view --web` prints the URL; do not open browsers from here |

## Rules

- Never run `glab auth login` or `glab auth status` for the user; tokens come from the exe secret store. On an auth error run `exe doctor --context <name>` and report the failing line.
- Before `create`, `approve`, `merge` or anything that pushes, show the exact command and wait unless the user already asked for it explicitly.
- Do not paste whole job logs. Quote the shortest decisive lines and say which job and stage.
- If the repo has no GitLab remote, say so; do not guess a project path.
