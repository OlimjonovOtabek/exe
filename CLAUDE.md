# exe

Claude Code plugin marketplace. Four plugins under `plugins/`, one installer, shared helpers under `bootstrap/`. Design page with phases and decisions: see the README.

## Conventions

- Node scripts, CommonJS, no build step, Node 20+. Bash for shims and the installer.
- No tokens anywhere in the repo, in settings files, or in session environment. Tokens live in the secret store (`plugins/exe-contexts/bin/secrets.sh`) and are injected per command by the shims in `plugins/exe-contexts/bin/shims/`.
- Docs, commit messages and skill files are normal prose written for humans.
- Skills keep tool output small: paginate, pick columns, never dump logs.
- A plugin's `version` in `.claude-plugin/plugin.json` must match its entry in `.claude-plugin/marketplace.json`; `claude plugin validate .` warns otherwise.

## Check before committing

```
node --test "plugins/*/tests/*.test.js" "bootstrap/tests/*.test.js"
claude plugin validate . && for p in plugins/*; do claude plugin validate "$p"; done
bash -n install.sh && bash install.sh --source "$PWD" --dry-run
```

Tests use temporary directories only (`EXE_CONFIG_DIR`, `EXE_PROFILES`, `EXE_STATE_DIR`, `CLAUDE_CONFIG_DIR`, `XDG_CONFIG_HOME`). Shim behaviour is tested with fake `jira` and `glab` executables placed after the shim directory on PATH.

## Layout

- `install.sh`: idempotent bootstrap. `act` runs a step or prints it under `--dry-run`.
- `bootstrap/merge-settings.js`: deep-merge into `~/.claude/settings.json`; the only thing that writes settings.
- `plugins/exe-kit`: dependencies-only bundle.
- `plugins/exe-contexts`: profiles, context resolution (`lib/profiles.js`), tool setup (`lib/setup.js`), doctor, shims, hooks, skills.
- `plugins/exe-usage`: status line (`statusline/`), samples and predictor (`lib/samples.js`), transcript aggregator (`lib/aggregate.js`), analyst (`lib/analyst.js`), Telegram, hooks in `bin/guard.js`.
- `plugins/exe-figma`: MCP wrapper injecting the context's Figma token.
