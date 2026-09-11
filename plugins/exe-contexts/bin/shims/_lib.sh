# Shared by the exe shims. Sourced, not executed.
#
# exe_real NAME  prints the first executable called NAME on PATH that is not a shim
# exe_env ONLY   evals the context exports for the current directory (tokens included)

exe_shim_dir() { cd "$(dirname "${BASH_SOURCE[1]}")" && pwd; }

exe_real() {
  local name="$1" here="$2" dir
  local IFS=:
  for dir in $PATH; do
    [ "$dir" = "$here" ] && continue
    if [ -x "$dir/$name" ] && [ ! -d "$dir/$name" ]; then printf '%s\n' "$dir/$name"; return 0; fi
  done
  return 1
}

exe_env() {
  local root="$1" only="$2" exports
  exports="$(node "$root/bin/ctx.js" ctx env --cwd "$PWD" --with-secrets --only "$only" 2>/dev/null)" || return 0
  eval "$exports"
}
