# exe

One install for the way you work with Claude Code.

`exe` is a [Claude Code plugin marketplace](https://code.claude.com/docs/en/plugin-marketplaces). It carries:

| Plugin | What it does | Status |
|---|---|---|
| `exe-kit` | The bundle. Installing it installs everything below plus caveman, ast-index and Matt Pocock's skills. | ready |
| `exe-contexts` | Jira, GitLab and git identity per organization, picked automatically from the repo's remote host. | Phase 1 |
| `exe-usage` | Usage-limit guard: status line with rate-limit windows, burn-rate prediction, transcript analysis, Telegram alerts. | Phase 2 |
| `exe-figma` | Figma with one personal access token per context. Enabled per project, not part of the bundle. | Phase 3 |

The build plan with phases, acceptance checks and the reasoning behind each choice lives in the project's design page.

## Install

On a fresh Mac or Linux machine:

```bash
curl -fsSL https://raw.githubusercontent.com/olimjonovotabek/exe/main/install.sh | bash
```

Add `--pxpipe` to also run the [pxpipe](https://github.com/teamchong/pxpipe) token-saving proxy as a background service and route Claude Code through it:

```bash
curl -fsSL https://raw.githubusercontent.com/olimjonovotabek/exe/main/install.sh | bash -s -- --pxpipe
```

The installer is idempotent. Run it again any time; it only touches what is missing. Restart Claude Code afterwards so the new plugins load.

### What the installer does

1. Checks `git`, `curl` and Node 20 or newer.
2. Installs Claude Code with the native installer when it is missing.
3. Installs `glab`, `jira-cli` and the `ast-index` binary. Homebrew on macOS; on Linux it uses Homebrew or cargo when present and otherwise prints where to get them.
4. Installs `pxpipe-proxy` and `ccusage` from npm.
5. Registers the caveman, ast-index and official marketplaces, then this one.
6. Installs `exe-kit`, which pulls in every plugin of the set.
7. With `--pxpipe`: registers pxpipe as a launchd agent or systemd user unit and sets `ANTHROPIC_BASE_URL` in `~/.claude/settings.json`.

### Flags

| Flag | Effect |
|---|---|
| `--pxpipe` | Run pxpipe as a service and route Claude Code through it |
| `--models LIST` | pxpipe model allowlist, comma separated. Default `claude-fable-5`, which also covers Fable 5.1. Add `claude-opus-5` or `claude-sonnet-5` to image those too |
| `--no-tools` | Skip glab, jira-cli and ast-index |
| `--source PATH` | Use a local checkout of this repo as the marketplace, for development |
| `--dry-run` | Print what would change without changing anything |

### Without the installer

```bash
claude plugin marketplace add JuliusBrussee/caveman
claude plugin marketplace add defendend/Claude-ast-index-search
claude plugin marketplace add olimjonovotabek/exe
claude plugin install exe-kit@exe
```

## Secrets

Tokens never live in this repo or in settings files. The helper stores them in the macOS Keychain, in `secret-tool` on Linux, or in a mode-600 file as a last resort. A stored value of the form `op://vault/item/field` is resolved through the 1Password CLI.

```bash
bash ~/.claude/plugins/marketplaces/exe/bootstrap/secrets.sh set jira-uzinfocom
bash ~/.claude/plugins/marketplaces/exe/bootstrap/secrets.sh get jira-uzinfocom
bash ~/.claude/plugins/marketplaces/exe/bootstrap/secrets.sh list
```

Names the plugins will look for: `jira-<context>`, `gitlab-<context>`, `figma-<context>`, `telegram-bot-token`, `telegram-chat-id`, `anthropic-api-key`. Any of them can be overridden for one shell with `EXE_SECRET_<NAME>` in upper case, dashes as underscores.

## pxpipe

pxpipe images bulky, static context so it costs fewer input tokens. It is lossy on exact strings inside imaged content, so keep IDs, hashes and secrets in small text results. Manage the service with:

```bash
bash ~/.claude/plugins/marketplaces/exe/bootstrap/pxpipe-service.sh status
bash ~/.claude/plugins/marketplaces/exe/bootstrap/pxpipe-service.sh uninstall
```

To stop routing Claude Code through it, remove `ANTHROPIC_BASE_URL` from `~/.claude/settings.json`:

```bash
node ~/.claude/plugins/marketplaces/exe/bootstrap/merge-settings.js ~/.claude/settings.json --remove env.ANTHROPIC_BASE_URL
```

## Layout

```
.claude-plugin/marketplace.json   the marketplace: four exe plugins, cross-marketplace allowlist
install.sh                        the installer
bootstrap/merge-settings.js       deep-merge a patch into a settings file, idempotent, with backup
bootstrap/secrets.sh              keychain / secret-tool / file secret store
bootstrap/pxpipe-service.sh       launchd or systemd service for pxpipe
plugins/exe-kit                   dependencies-only bundle
plugins/exe-contexts              Phase 1
plugins/exe-usage                 Phase 2
plugins/exe-figma                 Phase 3
```

## Uninstall

```bash
claude plugin uninstall exe-kit@exe --prune
claude plugin marketplace remove exe
bash ~/.claude/plugins/marketplaces/exe/bootstrap/pxpipe-service.sh uninstall   # if you enabled it
```

## License

MIT. See [LICENSE](LICENSE).
