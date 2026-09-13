# exe

One install for the way you work with Claude Code.

`exe` is a [Claude Code plugin marketplace](https://code.claude.com/docs/en/plugin-marketplaces). It carries:

| Plugin | What it does | Status |
|---|---|---|
| `exe-kit` | The bundle. Installing it installs everything below plus caveman, ast-index and Matt Pocock's skills. | ready |
| `exe-contexts` | Jira, GitLab and git identity per organization, picked automatically from the repo's remote host. Tokens stay in the keychain. | ready |
| `exe-usage` | Usage-limit guard: status line with both rate-limit windows, burn-rate prediction, transcript analysis by Fable, Telegram alerts. | ready |
| `exe-figma` | Figma with one personal access token per context. Enabled per project, not part of the bundle. | ready |

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
3. Installs `glab`, `jira-cli` and the `ast-index` binary. Homebrew on macOS; on Linux it uses Homebrew when present and otherwise downloads the release binaries into `~/.local/bin` and builds ast-index with cargo.
4. Installs `pxpipe-proxy` and `ccusage` from npm.
5. Registers the caveman, ast-index and official marketplaces, then this one.
6. Installs `exe-kit`, which pulls in every plugin of the set, and links the `exe` command into `~/.local/bin`.
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

## Contexts

A context is one organization: its Jira, its GitLab host, its Figma account and the email you commit with. The context of a directory is chosen, in order, from `EXE_CONTEXT`, then `.exe.json` at the git root, then the host of the `origin` remote, then the default in the profiles file.

Set it up once:

```bash
exe ctx init                       # writes ~/.config/exe/profiles.json from the template; edit it
exe secret set jira-uzinfocom      # prompts for the token, stores it in the keychain
exe secret set gitlab-uzinfocom
exe setup all                      # git identities per host, jira-cli config per context
exe doctor                         # one live call per token, plus tools and proxy
```

Then work as usual. Inside Claude Code sessions `jira` and `glab` are shims: they run the real tools with the token and config of the current directory's context, so the same command reaches jira.uzinfocom.uz in one repo and bepro-devhub.atlassian.net in another. Nothing is exported into the session environment.

In your own terminal, either use the shims too:

```bash
export PATH="$HOME/.claude/plugins/marketplaces/exe/plugins/exe-contexts/bin/shims:$PATH"
```

or load one context into the current shell:

```bash
eval "$(exe ctx env --with-secrets)"
```

Useful commands:

| Command | Effect |
|---|---|
| `exe ctx show` | which context applies here and why |
| `exe ctx list` | all contexts |
| `exe ctx use devhub` | pin this repo to a context, written to `.exe.json` at the git root |
| `exe setup glab` | also store the tokens in glab's own keyring, for terminals without the shim |
| `exe doctor --context uzinfocom` | check one context |

A profile, abbreviated:

```json
{
  "default": "personal",
  "contexts": {
    "uzinfocom": {
      "match":  { "remoteHosts": ["gitlab.uzinfocom.uz"] },
      "jira":   { "kind": "datacenter", "url": "https://jira.uzinfocom.uz", "login": "your.username", "token": "secret:jira-uzinfocom", "project": "PROJ" },
      "gitlab": { "host": "gitlab.uzinfocom.uz", "token": "secret:gitlab-uzinfocom" },
      "figma":  { "token": "secret:figma-work" },
      "git":    { "name": "Otabek Olimjonov", "email": "you@uzinfocom.uz" }
    }
  }
}
```

`jira.kind` is `datacenter` for a self-hosted Jira with a personal access token, or `cloud` for an Atlassian site with an API token, where `login` is your email. Token values are references: `secret:NAME`, `env:VAR`, or `op://vault/item/field` for the 1Password CLI. The full template is at `plugins/exe-contexts/templates/profiles.example.json`.

Inside Claude Code the plugin adds three skills: `/ctx`, `/jira` and `/gitlab`, with compact-output recipes so tool results stay small.

## Usage guard

The installer sets Claude Code's status line to exe's script. It shows the model and effort, both rate-limit windows with the time to reset, context fill and session cost, and records a sample once a minute:

```
Fable 5.1·high │ 5h 62% ↻1h12m │ 7d 41% │ ctx 38% │ $0.53 │ px on
```

A `!` after a window means the current burn rate reaches 100% before the reset. Rate-limit percentages arrive only on Pro and Max plans; other plans see `limits n/a` and the reports still work from the transcripts.

What happens, and when:

| Moment | What exe-usage does | Model call |
|---|---|---|
| every turn end | reads the samples, projects the burn rate; above the threshold and heading for the wall, starts the analysis in the background, once per window | only when triggered |
| the limit ends a turn | Telegram message with both windows, the top models and projects of the window, the largest tool result | none |
| Claude resumes after the reset, or waits for you | Telegram message | none |
| `/why-limits` | ranked causes with evidence and three to five actions, from a headless call on the analysis model | one |
| `/usage-report` | markdown tables by model, effort, project, long sessions, largest tool results, plugin context cost, pxpipe savings | none |

The analysis reads a compact summary computed locally, never raw transcripts. It runs outside pxpipe, without session persistence, and at most once per window unless forced with `--now`. With `analysis_auth` set to `api_key` it runs in bare mode on an API key, immune to the limit it explains.

Configure the bot and the analyst once, through `/plugin configure exe-usage` or `claude plugin install exe-usage@exe --config telegram_bot_token=... --config telegram_chat_id=...`, or in `~/.config/exe/usage.json`:

```json
{
  "telegram_bot_token": "123456:ABC...",
  "telegram_chat_id": "987654321",
  "analysis_model": "claude-fable-5-1",
  "analysis_effort": "high",
  "analysis_auth": "subscription",
  "threshold_percent": "60",
  "pager": "off"
}
```

Set `pager` to `on` to also get a message when Claude waits for permission or input. State lives in `~/.local/state/exe/usage`: samples, reports and the alert log used when no bot is configured.

## Figma

Three Figma accounts, one MCP entry. exe-figma starts [figma-developer-mcp](https://github.com/GLips/Figma-Context-MCP) with the personal access token of the current directory's context, taken from the same profiles and secret store as Jira and GitLab. It is not part of the bundle; enable it where design work happens:

```bash
claude plugin install exe-figma@exe
claude plugin enable exe-figma@exe --scope project     # inside the project
exe secret set figma-work                               # one token per account
```

The official Figma MCP server follows the browser or desktop login and holds one account at a time, which is why exe uses personal access tokens instead. Token access loses the Dev Mode selection features, and Starter-plan files allow only a handful of API reads per month.

## Releases

Every plugin carries its version in `.claude-plugin/plugin.json` and in its marketplace entry; `claude plugin validate .` warns when they differ. Tag a release from the plugin directory with `claude plugin tag --push`, which creates `<plugin>--v<version>`, so the bundle can pin dependency ranges later. GitHub Actions runs the tests, the syntax checks and `claude plugin validate` on every push.

## Secrets

Tokens never live in this repo or in settings files. The store is the macOS Keychain, `secret-tool` on Linux, or a mode-600 file as a last resort. A stored value of the form `op://vault/item/field` is resolved through the 1Password CLI.

```bash
exe secret set jira-uzinfocom
exe secret get jira-uzinfocom
exe secret list
```

Any secret can be overridden for one shell with `EXE_SECRET_<NAME>` in upper case, dashes as underscores.

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
bin/exe                           the exe command for your terminal
bootstrap/merge-settings.js       deep-merge a patch into a settings file, idempotent, with backup
bootstrap/pxpipe-service.sh       launchd or systemd service for pxpipe
bootstrap/secrets.sh              shim to the secret store inside exe-contexts
plugins/exe-kit                   dependencies-only bundle
plugins/exe-contexts              profiles, shims, hooks, skills, doctor, secret store
plugins/exe-usage                 status line, predictor, aggregator, analyst, Telegram, hooks, skills
plugins/exe-figma                 MCP wrapper injecting the context's Figma token, skill
.github/workflows/validate.yml    tests, syntax checks and plugin validation on every push
```

Tests: `node --test "plugins/*/tests/*.test.js"`. Validation: `claude plugin validate .`

## Uninstall

```bash
claude plugin uninstall exe-kit@exe --prune
claude plugin marketplace remove exe
rm -f ~/.local/bin/exe
bash ~/.claude/plugins/marketplaces/exe/bootstrap/pxpipe-service.sh uninstall   # if you enabled it
```

## License

MIT. See [LICENSE](LICENSE).
