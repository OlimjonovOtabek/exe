#!/usr/bin/env bash
# exe installer: one command to set up a machine for Claude Code the way you work.
#
#   curl -fsSL https://raw.githubusercontent.com/olimjonovotabek/exe/main/install.sh | bash
#   curl -fsSL https://raw.githubusercontent.com/olimjonovotabek/exe/main/install.sh | bash -s -- --pxpipe
#
# What it does, in order (every step is skipped when already done):
#   1. checks git, curl and Node 20+
#   2. installs Claude Code (native installer) when missing
#   3. installs glab, jira-cli and the ast-index binary (Homebrew on macOS; best effort on Linux)
#   4. installs pxpipe-proxy and ccusage from npm
#   5. registers the caveman, ast-index and official marketplaces, then the exe marketplace
#   6. installs exe-kit, which pulls in every plugin of the set
#   7. with --pxpipe: runs pxpipe as a background service and routes Claude Code through it
#
# Flags:
#   --pxpipe          opt in to the pxpipe proxy (service + ANTHROPIC_BASE_URL in user settings)
#   --models LIST     pxpipe model allowlist, comma separated (default: claude-fable-5)
#   --no-tools        skip glab, jira-cli and ast-index
#   --source PATH     use a local checkout of this repo as the exe marketplace (development)
#   --dry-run         print what would change without changing anything
#   -h, --help        this text
#
# Environment overrides: EXE_REPO (default olimjonovotabek/exe), EXE_PXPIPE_PORT (default 47821).

set -euo pipefail

EXE_REPO="${EXE_REPO:-olimjonovotabek/exe}"
EXE_MARKETPLACE="exe"
EXE_PXPIPE_PORT="${EXE_PXPIPE_PORT:-47821}"
EXE_PXPIPE_MODELS="${EXE_PXPIPE_MODELS:-claude-fable-5}"
WITH_PXPIPE=0
WITH_TOOLS=1
DRY_RUN=0
SOURCE_PATH=""

usage() { sed -n '2,24p' "$0" 2>/dev/null || echo "see https://github.com/$EXE_REPO#readme"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --pxpipe) WITH_PXPIPE=1 ;;
    --models) EXE_PXPIPE_MODELS="$2"; shift ;;
    --no-tools) WITH_TOOLS=0 ;;
    --source) SOURCE_PATH="$2"; shift ;;
    --dry-run) DRY_RUN=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown flag: $1" >&2; usage; exit 2 ;;
  esac
  shift
done

# ---------- output helpers ----------
if [ -t 1 ]; then
  C_OK=$'\033[32m'; C_SKIP=$'\033[2m'; C_WARN=$'\033[33m'; C_FAIL=$'\033[31m'; C_HEAD=$'\033[1m'; C_END=$'\033[0m'
else
  C_OK=""; C_SKIP=""; C_WARN=""; C_FAIL=""; C_HEAD=""; C_END=""
fi
SUMMARY=()
head_() { printf '\n%s== %s ==%s\n' "$C_HEAD" "$1" "$C_END"; }
ok()    { printf '%s  ok    %s%s\n' "$C_OK" "$1" "$C_END"; SUMMARY+=("ok    $1"); }
skip()  { printf '%s  skip  %s%s\n' "$C_SKIP" "$1" "$C_END"; SUMMARY+=("skip  $1"); }
warn()  { printf '%s  warn  %s%s\n' "$C_WARN" "$1" "$C_END"; SUMMARY+=("warn  $1"); }
fail()  { printf '%s  fail  %s%s\n' "$C_FAIL" "$1" "$C_END"; SUMMARY+=("fail  $1"); }
die()   { fail "$1"; exit 1; }
run()   { if [ "$DRY_RUN" = 1 ]; then printf '  would run: %s\n' "$*"; else "$@"; fi; }
# act "message" cmd...: in dry-run print what would happen; otherwise run cmd and report ok or fail.
act() {
  local msg="$1"; shift
  if [ "$DRY_RUN" = 1 ]; then printf '  would  %s  [%s]\n' "$msg" "$*"; SUMMARY+=("would $msg"); return 0; fi
  if "$@"; then ok "$msg"; else fail "$msg"; fi
}

OS="$(uname -s)"
case "$OS" in Darwin|Linux) ;; *) die "unsupported OS: $OS (macOS and Linux only)";; esac

# ---------- 1. prerequisites ----------
head_ "prerequisites"
for bin in git curl; do
  command -v "$bin" >/dev/null 2>&1 && ok "$bin present" || die "$bin is required"
done

node_major() { node -v 2>/dev/null | sed -E 's/^v([0-9]+).*/\1/'; }
if command -v node >/dev/null 2>&1 && [ "$(node_major)" -ge 20 ]; then
  ok "node $(node -v)"
else
  if [ "$OS" = Darwin ] && command -v brew >/dev/null 2>&1; then
    run brew install node && ok "node installed via Homebrew"
  else
    die "Node 20+ is required. Install it from https://nodejs.org or with your package manager, then rerun."
  fi
fi
export PATH="$HOME/.local/bin:$(npm prefix -g 2>/dev/null)/bin:$PATH"

# ---------- 2. Claude Code ----------
head_ "Claude Code"
if command -v claude >/dev/null 2>&1; then
  ok "claude $(claude --version 2>/dev/null | head -1)"
else
  if [ "$DRY_RUN" = 1 ]; then
    printf '  would run: curl -fsSL https://claude.ai/install.sh | bash\n'
  else
    curl -fsSL https://claude.ai/install.sh | bash
    export PATH="$HOME/.local/bin:$PATH"
    command -v claude >/dev/null 2>&1 || die "claude not on PATH after install; open a new shell and rerun"
  fi
  ok "claude installed"
fi

# ---------- 3. CLI tools ----------
head_ "tools"
brew_install() {
  # $1 formula shown to the user, $2 optional tap, $3 optional full formula name
  local name="$1" tap="${2:-}" formula="${3:-$1}"
  if command -v "$name" >/dev/null 2>&1; then skip "$name already installed"; return; fi
  if ! command -v brew >/dev/null 2>&1; then warn "$name: Homebrew missing, install it from https://brew.sh and rerun"; return; fi
  if [ -n "$tap" ]; then run brew tap "$tap" >/dev/null; fi
  act "$name installed" brew install -q "$formula"
}
# Linux without Homebrew: fetch the release binaries into ~/.local/bin.
linux_arch() { case "$(uname -m)" in x86_64) echo "$1";; aarch64|arm64) echo arm64;; *) return 1;; esac; }
install_glab_linux() {
  local arch tag ver tmp
  arch="$(linux_arch amd64)" || { echo "no glab build for $(uname -m)" >&2; return 1; }
  tag="$(curl -fsSL 'https://gitlab.com/api/v4/projects/gitlab-org%2Fcli/releases?per_page=1' | grep -o '"tag_name":"[^"]*"' | head -1 | cut -d'"' -f4)"
  [ -n "$tag" ] || { echo "could not read the latest glab release" >&2; return 1; }
  ver="${tag#v}"; tmp="$(mktemp -d)"
  curl -fsSL "https://gitlab.com/gitlab-org/cli/-/releases/$tag/downloads/glab_${ver}_linux_${arch}.tar.gz" | tar xz -C "$tmp"
  mkdir -p "$HOME/.local/bin" && install -m 0755 "$(find "$tmp" -type f -name glab | head -1)" "$HOME/.local/bin/glab"
}
install_jira_linux() {
  local arch tag ver tmp
  arch="$(linux_arch x86_64)" || { echo "no jira-cli build for $(uname -m)" >&2; return 1; }
  tag="$(git ls-remote --tags --refs https://github.com/ankitpokhrel/jira-cli 2>/dev/null | awk -F/ '{print $NF}' | sort -V | tail -1)"
  [ -n "$tag" ] || { echo "could not read the latest jira-cli release" >&2; return 1; }
  ver="${tag#v}"; tmp="$(mktemp -d)"
  curl -fsSL "https://github.com/ankitpokhrel/jira-cli/releases/download/$tag/jira_${ver}_linux_${arch}.tar.gz" | tar xz -C "$tmp"
  mkdir -p "$HOME/.local/bin" && install -m 0755 "$(find "$tmp" -type f -name jira | head -1)" "$HOME/.local/bin/jira"
}
if [ "$WITH_TOOLS" = 1 ]; then
  if [ "$OS" = Darwin ] || command -v brew >/dev/null 2>&1; then
    brew_install glab
    brew_install jira ankitpokhrel/jira-cli jira-cli
    brew_install ast-index defendend/ast-index ast-index
  else
    command -v glab >/dev/null 2>&1 && skip "glab already installed" || act "glab installed to ~/.local/bin" install_glab_linux
    command -v jira >/dev/null 2>&1 && skip "jira-cli already installed" || act "jira-cli installed to ~/.local/bin" install_jira_linux
    if command -v ast-index >/dev/null 2>&1; then skip "ast-index already installed"
    elif command -v cargo >/dev/null 2>&1; then act "ast-index installed via cargo" cargo install -q ast-index --locked
    else warn "ast-index: install with 'cargo install ast-index --locked' or see https://github.com/defendend/Claude-ast-index-search"; fi
  fi
else
  skip "tools (--no-tools)"
fi

# ---------- 4. npm tools ----------
head_ "npm tools"
npm_install() {
  local pkg="$1" bin="$2"
  if command -v "$bin" >/dev/null 2>&1; then skip "$pkg already installed"; return; fi
  act "$pkg installed" npm install -g --silent "$pkg"
}
npm_install pxpipe-proxy pxpipe
npm_install ccusage ccusage
npm_install figma-developer-mcp figma-developer-mcp

# ---------- 5. marketplaces ----------
head_ "marketplaces"
has_marketplace() { claude plugin marketplace list 2>/dev/null | grep -qE "^[[:space:]]*>?[[:space:]]*$1[[:space:]]*$"; }
add_marketplace() {
  local name="$1" source="$2"
  if has_marketplace "$name"; then skip "marketplace $name already configured"; return; fi
  if [ "$DRY_RUN" = 1 ]; then printf '  would run: claude plugin marketplace add %s\n' "$source"; return; fi
  claude plugin marketplace add "$source" >/dev/null 2>&1 && ok "marketplace $name added" || warn "marketplace $name could not be added from $source"
}
add_marketplace claude-plugins-official anthropics/claude-plugins-official
add_marketplace caveman JuliusBrussee/caveman
add_marketplace ast-index-marketplace defendend/Claude-ast-index-search
if [ -n "$SOURCE_PATH" ]; then
  add_marketplace "$EXE_MARKETPLACE" "$SOURCE_PATH"
  EXE_ROOT="$SOURCE_PATH"
else
  add_marketplace "$EXE_MARKETPLACE" "$EXE_REPO"
  EXE_ROOT="$HOME/.claude/plugins/marketplaces/$EXE_MARKETPLACE"
fi

# ---------- 6. the bundle ----------
head_ "exe-kit"
if [ "$DRY_RUN" = 1 ]; then
  printf '  would run: claude plugin install exe-kit@%s -y\n' "$EXE_MARKETPLACE"
else
  if claude plugin list 2>/dev/null | grep -q "exe-kit@$EXE_MARKETPLACE"; then kit_msg="exe-kit already installed, dependencies checked"; else kit_msg="exe-kit installed with its dependencies"; fi
  if claude plugin install "exe-kit@$EXE_MARKETPLACE" -y >/dev/null 2>&1; then
    ok "$kit_msg"
  else
    fail "exe-kit install failed; run: claude plugin install exe-kit@$EXE_MARKETPLACE -y"
  fi
  if [ -x "$EXE_ROOT/bin/exe" ]; then
    mkdir -p "$HOME/.local/bin"
    if [ "$(readlink "$HOME/.local/bin/exe" 2>/dev/null)" = "$EXE_ROOT/bin/exe" ]; then skip "exe command already linked"
    else act "exe command linked to ~/.local/bin/exe" ln -sfn "$EXE_ROOT/bin/exe" "$HOME/.local/bin/exe"; fi
    case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) warn "add ~/.local/bin to PATH so the exe command works in your terminal" ;; esac
  fi
fi

# ---------- 6b. status line ----------
head_ "status line"
STATUSLINE_SCRIPT="$EXE_ROOT/plugins/exe-usage/statusline/statusline.js"
if [ -f "$STATUSLINE_SCRIPT" ] && [ -f "$EXE_ROOT/bootstrap/merge-settings.js" ]; then
  current="$(node -e 'try{const s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write((s.statusLine&&s.statusLine.command)||"")}catch(e){}' "$HOME/.claude/settings.json" 2>/dev/null || true)"
  if [ -n "$current" ] && [ "${current#*exe-usage/statusline/statusline.js}" = "$current" ]; then
    warn "status line already set to something else; to use exe's, set statusLine.command to: node \"$STATUSLINE_SCRIPT\""
  elif [ "$DRY_RUN" = 1 ]; then
    printf '  would set: statusLine.command=node "%s"\n' "$STATUSLINE_SCRIPT"
  else
    result="$(node "$EXE_ROOT/bootstrap/merge-settings.js" "$HOME/.claude/settings.json" "{\"statusLine\":{\"type\":\"command\",\"command\":\"node \\\"$STATUSLINE_SCRIPT\\\"\"}}")"
    case "$result" in
      changed) ok "status line set (5h and 7d limit windows, context, cost)" ;;
      unchanged) skip "status line already exe's" ;;
      *) fail "could not update ~/.claude/settings.json for the status line" ;;
    esac
  fi
else
  skip "status line (exe-usage not present yet)"
fi

# ---------- 7. pxpipe (opt-in) ----------
head_ "pxpipe"
if [ "$WITH_PXPIPE" = 1 ]; then
  if [ -f "$EXE_ROOT/bootstrap/pxpipe-service.sh" ]; then
    if [ "$DRY_RUN" = 1 ]; then
      printf '  would run: pxpipe-service.sh install (port %s, models %s)\n' "$EXE_PXPIPE_PORT" "$EXE_PXPIPE_MODELS"
      printf '  would set: env.ANTHROPIC_BASE_URL=http://127.0.0.1:%s in ~/.claude/settings.json\n' "$EXE_PXPIPE_PORT"
    else
      EXE_PXPIPE_PORT="$EXE_PXPIPE_PORT" EXE_PXPIPE_MODELS="$EXE_PXPIPE_MODELS" \
        bash "$EXE_ROOT/bootstrap/pxpipe-service.sh" install && ok "pxpipe service running on port $EXE_PXPIPE_PORT" \
        || fail "pxpipe service did not start"
      result="$(node "$EXE_ROOT/bootstrap/merge-settings.js" "$HOME/.claude/settings.json" \
        "{\"env\":{\"ANTHROPIC_BASE_URL\":\"http://127.0.0.1:$EXE_PXPIPE_PORT\"}}")"
      case "$result" in
        changed) ok "Claude Code now routes through pxpipe (env.ANTHROPIC_BASE_URL in ~/.claude/settings.json)" ;;
        unchanged) skip "Claude Code already routes through pxpipe" ;;
        *) fail "could not update ~/.claude/settings.json" ;;
      esac
    fi
  else
    fail "bootstrap files not found at $EXE_ROOT; rerun after the marketplace is added"
  fi
else
  skip "pxpipe not enabled (pass --pxpipe to run it as a service and route Claude Code through it)"
fi

# ---------- summary ----------
head_ "summary"
printf '  ok %s, skipped %s, warnings %s, failed %s\n' "$(printf '%s\n' "${SUMMARY[@]}" | grep -c '^ok ' || true)" \
  "$(printf '%s\n' "${SUMMARY[@]}" | grep -c '^skip ' || true)" \
  "$(printf '%s\n' "${SUMMARY[@]}" | grep -c '^warn ' || true)" \
  "$(printf '%s\n' "${SUMMARY[@]}" | grep -c '^fail ' || true)"
printf '\nNext:\n'
printf '  restart Claude Code so the new plugins load\n'
printf '  create profiles: exe ctx init   (then edit ~/.config/exe/profiles.json)\n'
printf '  store a token:   exe secret set jira-uzinfocom\n'
printf '  apply and check: exe setup all && exe doctor\n'
[ "$WITH_PXPIPE" = 1 ] || printf '  enable pxpipe:   rerun with --pxpipe\n'
printf '  rerun any time; it only changes what is missing\n'
