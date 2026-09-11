#!/usr/bin/env bash
# Shim: the secret store lives in the exe-contexts plugin so it ships with the plugin.
# This keeps the documented path ~/.claude/plugins/marketplaces/exe/bootstrap/secrets.sh working.
exec bash "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/plugins/exe-contexts/bin/secrets.sh" "$@"
