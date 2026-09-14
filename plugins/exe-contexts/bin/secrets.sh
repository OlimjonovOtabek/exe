#!/usr/bin/env bash
# exe secrets helper. Tokens never live in the repo or in settings files.
#
#   secrets.sh set NAME [VALUE]   store a secret (prompts when VALUE is omitted)
#   secrets.sh get NAME           print a secret
#   secrets.sh delete NAME        remove a secret
#   secrets.sh list               list stored names
#   secrets.sh backend            print which store is in use
#
# Backends, picked automatically:
#   macOS            Keychain (security), service "exe", account NAME
#   Linux            secret-tool (libsecret) when present
#   fallback         ~/.config/exe/secrets.env, mode 600
#
# Resolution order for get:
#   1. EXE_SECRET_<NAME> environment variable (NAME upper-cased, dashes to underscores)
#   2. the stored value; a stored value of the form op://vault/item/field is
#      resolved through the 1Password CLI (`op read`)
#
# Names used by exe: jira-<context>, gitlab-<context>, figma-<context>,
# telegram-bot-token, telegram-chat-id, anthropic-api-key.

set -euo pipefail
umask 077

SERVICE="exe"
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/exe"
FILE_STORE="$CONFIG_DIR/secrets.env"
INDEX="$CONFIG_DIR/secrets.index"

upper() { printf '%s' "$1" | tr '[:lower:]-' '[:upper:]_'; }

backend() {
  case "$(uname -s)" in
    Darwin) echo keychain ;;
    *) if command -v secret-tool >/dev/null 2>&1; then echo secret-tool; else echo file; fi ;;
  esac
}

index_add() { mkdir -p "$CONFIG_DIR"; touch "$INDEX"; grep -qxF "$1" "$INDEX" || echo "$1" >> "$INDEX"; }
index_remove() { [ -f "$INDEX" ] || return 0; grep -vxF "$1" "$INDEX" > "$INDEX.tmp" || true; mv "$INDEX.tmp" "$INDEX"; }

raw_get() {
  local name="$1"
  case "$(backend)" in
    keychain) security find-generic-password -s "$SERVICE" -a "$name" -w 2>/dev/null || true ;;
    secret-tool) secret-tool lookup service "$SERVICE" name "$name" 2>/dev/null || true ;;
    file) [ -f "$FILE_STORE" ] && grep -E "^$(upper "$name")=" "$FILE_STORE" | head -1 | cut -d= -f2- || true ;;
  esac
}

cmd_get() {
  local name="$1" envvar value
  envvar="EXE_SECRET_$(upper "$name")"
  if [ -n "${!envvar:-}" ]; then printf '%s' "${!envvar}"; return 0; fi
  value="$(raw_get "$name")"
  if [ -z "$value" ]; then echo "exe secrets: no secret named '$name'" >&2; return 1; fi
  case "$value" in
    op://*) command -v op >/dev/null 2>&1 || { echo "exe secrets: '$name' is a 1Password reference but 'op' is not installed" >&2; return 1; }
            op read "$value" ;;
    *) printf '%s' "$value" ;;
  esac
}

cmd_set() {
  local name="$1" value="${2:-}"
  if [ -z "$value" ]; then
    if [ ! -t 0 ]; then echo "exe secrets: no value given and no terminal to prompt on" >&2; return 1; fi
    printf 'Value for %s (input hidden): ' "$name" >&2
    read -rs value; echo >&2
  fi
  [ -n "$value" ] || { echo "exe secrets: empty value, nothing stored" >&2; return 1; }
  case "$(backend)" in
    keychain) security add-generic-password -U -s "$SERVICE" -a "$name" -w "$value" >/dev/null ;;
    secret-tool) printf '%s' "$value" | secret-tool store --label="exe: $name" service "$SERVICE" name "$name" ;;
    file)
      mkdir -p "$CONFIG_DIR"; umask 077; touch "$FILE_STORE"
      grep -vE "^$(upper "$name")=" "$FILE_STORE" > "$FILE_STORE.tmp" || true
      printf '%s=%s\n' "$(upper "$name")" "$value" >> "$FILE_STORE.tmp"
      mv "$FILE_STORE.tmp" "$FILE_STORE"; chmod 600 "$FILE_STORE" ;;
  esac
  index_add "$name"
  echo "stored $name ($(backend))" >&2
}

cmd_delete() {
  local name="$1"
  case "$(backend)" in
    keychain) security delete-generic-password -s "$SERVICE" -a "$name" >/dev/null 2>&1 || true ;;
    secret-tool) secret-tool clear service "$SERVICE" name "$name" 2>/dev/null || true ;;
    file) [ -f "$FILE_STORE" ] && { grep -vE "^$(upper "$name")=" "$FILE_STORE" > "$FILE_STORE.tmp" || true; mv "$FILE_STORE.tmp" "$FILE_STORE"; chmod 600 "$FILE_STORE"; } ;;
  esac
  index_remove "$name"
  echo "deleted $name" >&2
}

cmd_list() { [ -f "$INDEX" ] && cat "$INDEX" || true; }

case "${1:-}" in
  get) [ $# -ge 2 ] || { echo "usage: secrets.sh get NAME" >&2; exit 2; }; cmd_get "$2" ;;
  set) [ $# -ge 2 ] || { echo "usage: secrets.sh set NAME [VALUE]" >&2; exit 2; }; cmd_set "$2" "${3:-}" ;;
  delete) [ $# -ge 2 ] || { echo "usage: secrets.sh delete NAME" >&2; exit 2; }; cmd_delete "$2" ;;
  list) cmd_list ;;
  backend) backend ;;
  *) sed -n '2,20p' "$0"; exit 2 ;;
esac
