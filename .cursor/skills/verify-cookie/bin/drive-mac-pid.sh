# Pid checks for drive-mac. Bash 3.2. Sourced, not executed.
# A drive may touch a process only when its executable is the bundle it launched.

real_path() {
  python3 -c 'import os, sys; print(os.path.realpath(sys.argv[1]))' "$1"
}

# macOS `ps -o comm=` is the full executable path. `Cookie Agent.app` contains a
# space, so field $2 is only `/Applications/Cookie`. Strip the leading pid and
# take the basename of the rest of the line. `-ww` keeps the path from being
# truncated at the terminal width.
comm_pids_named() {
  local want="$1"
  ps -axww -o pid=,comm= 2>/dev/null | awk -v want="$want" '
    {
      pid = $1
      path = $0
      if (path !~ /^[[:space:]]*[0-9]+[[:space:]]+/) next
      sub(/^[[:space:]]*[0-9]+[[:space:]]+/, "", path)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", path)
      if (path == "") next
      n = split(path, parts, "/")
      name = parts[n]
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", name)
      if (name == want && pid ~ /^[0-9]+$/ && !seen[pid]++) print pid
    }
  '
}

cookieagent_comm_pids() {
  comm_pids_named "CookieAgent"
}

# CookieAgent pids that are not this drive's launched copy.
# $1 is that copy's pid. An empty own pid treats every CookieAgent as foreign.
foreign_cookieagent_pids() {
  local own="${1:-}"
  local pid
  while IFS= read -r pid; do
    [[ -n "$pid" ]] || continue
    if [[ -n "$own" && "$pid" == "$own" ]]; then
      continue
    fi
    printf '%s\n' "$pid"
  done < <(cookieagent_comm_pids)
}

# Immediately before option-space. Returns 0 when no foreign CookieAgent is running.
# Otherwise writes popup-hotkey-skip.txt, prints skipped, and exits 3.
# $1 is this drive's pid. $2 is the evidence directory.
guard_popup_hotkey_send() {
  local own="${1:-}"
  local dir="${2:-}"
  local foreign
  foreign="$(foreign_cookieagent_pids "$own" | tr '\n' ' ')"
  if [[ -z "${foreign// /}" ]]; then
    return 0
  fi
  if [[ -n "$dir" ]]; then
    mkdir -p "$dir"
    {
      printf '%s\n' "popup-hotkey skipped"
      printf '%s\n' "reason=a CookieAgent appeared after launch"
      printf '%s\n' "pids=${foreign}"
      printf '%s\n' "signaled=none"
    } >"$dir/popup-hotkey-skip.txt"
    if [[ -f "$dir/command.txt" ]]; then
      printf '%s\n' "popup-hotkey=skipped" >>"$dir/command.txt"
    fi
  fi
  printf '%s\n' "popup-hotkey skipped: a CookieAgent appeared after launch (pid ${foreign}); not sending option-space"
  printf '%s\n' "skipped"
  exit 3
}

process_comm_name() {
  local pid="$1"
  # The whole line is the comm value. It may be a full path with spaces.
  ps -ww -p "$pid" -o comm= 2>/dev/null | awk '
    {
      name = $0
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", name)
      n = split(name, parts, "/")
      if (n >= 1 && parts[n] != "") print parts[n]
    }
  '
}

info_plist_for_bin() {
  python3 -c 'import os, sys; print(os.path.realpath(os.path.join(os.path.dirname(sys.argv[1]), "..", "Info.plist")))' "$1"
}

plist_value() {
  local plist="$1"
  local key="$2"
  python3 - "$plist" "$key" <<'PY'
import plistlib
import sys

path, key = sys.argv[1], sys.argv[2]
with open(path, "rb") as handle:
    data = plistlib.load(handle)
value = data.get(key)
if not isinstance(value, str) or value == "":
    sys.exit(1)
print(value)
PY
}

# Print the txt path whose real path is $2. With no $2, the CookieAgent txt, else the first txt.
process_executable() {
  local pid="$1"
  local expected="${2:-}"
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  local paths first="" line want=""
  paths="$(lsof -a -p "$pid" -d txt -Fn 2>/dev/null | awk '/^n/ { sub(/^n/, ""); print }')"
  if [[ -n "$expected" ]]; then
    want="$(real_path "$expected")"
  fi
  while IFS= read -r line; do
    [[ -n "$line" ]] || continue
    if [[ -z "$first" ]]; then
      first="$line"
    fi
    if [[ -n "$want" && "$(real_path "$line")" == "$want" ]]; then
      printf '%s\n' "$line"
      return 0
    fi
    if [[ -z "$want" ]]; then
      case "$line" in
        */CookieAgent)
          printf '%s\n' "$line"
          return 0
          ;;
      esac
    fi
  done <<< "$paths"
  if [[ -n "$want" ]]; then
    return 1
  fi
  [[ -n "$first" ]] || return 1
  printf '%s\n' "$first"
}

pids_for_executable() {
  local want="$1"
  local comm_name="${2:-CookieAgent}"
  local want_real pid exe
  if [[ -z "$comm_name" ]]; then
    comm_name="CookieAgent"
  fi
  want_real="$(real_path "$want")"
  while IFS= read -r pid; do
    [[ -n "$pid" ]] || continue
    exe="$(process_executable "$pid" "$want" || true)"
    [[ -n "$exe" ]] || continue
    if [[ "$(real_path "$exe")" == "$want_real" ]]; then
      printf '%s\n' "$pid"
    fi
  done < <(comm_pids_named "$comm_name")
}

# $3 is the per-run executable name. $4 is the per-run bundle id.
# Both are required together. The product name and bundle id never pass.
verify_drive_identity_reason() {
  local pid="$1"
  local expected_bin="$2"
  local expected_name="$3"
  local expected_bundle="$4"
  if [[ "$expected_name" == "CookieAgent" ]]; then
    printf '%s\n' "process name CookieAgent is the product executable; the drive must use a per-run name"
    return 1
  fi
  if [[ "$expected_bundle" == "com.johnkimec.cookie-agent" ]]; then
    printf '%s\n' "bundle id com.johnkimec.cookie-agent is the installed app; the drive must use a per-run bundle id"
    return 1
  fi
  if [[ ! "$expected_name" =~ ^[A-Za-z][A-Za-z0-9]+$ ]]; then
    printf '%s\n' "process name ${expected_name:-empty} is not a per-run executable name"
    return 1
  fi
  case "$expected_bundle" in
    com.johnkimec.cookie-agent.drive.[0-9a-f]*) ;;
    *)
      printf '%s\n' "bundle id ${expected_bundle:-empty} is not a per-run drive bundle id"
      return 1
      ;;
  esac
  local comm
  comm="$(process_comm_name "$pid")"
  if [[ "$comm" != "$expected_name" ]]; then
    printf '%s\n' "pid $pid process name is ${comm:-missing}, expected $expected_name"
    return 1
  fi
  local plist exe_name bundle_id
  plist="$(info_plist_for_bin "$expected_bin")"
  exe_name="$(plist_value "$plist" CFBundleExecutable || true)"
  bundle_id="$(plist_value "$plist" CFBundleIdentifier || true)"
  if [[ "$exe_name" != "$expected_name" ]]; then
    printf '%s\n' "CFBundleExecutable is ${exe_name:-missing}, expected $expected_name"
    return 1
  fi
  if [[ "$bundle_id" != "$expected_bundle" ]]; then
    printf '%s\n' "bundle id is ${bundle_id:-missing}, expected $expected_bundle"
    return 1
  fi
  return 0
}

# Print a reason on stdout and return 1, or print nothing and return 0.
verify_drive_pid_reason() {
  local pid="$1"
  local expected="$2"
  if [[ ! "$pid" =~ ^[0-9]+$ ]]; then
    printf '%s\n' "launched pid is not one integer (${pid:-empty})"
    return 1
  fi
  if [[ "$pid" -lt 2 ]]; then
    printf '%s\n' "pid $pid is not a drive pid"
    return 1
  fi
  if ! kill -0 "$pid" 2>/dev/null; then
    printf '%s\n' "pid $pid is not running"
    return 1
  fi
  local exe
  exe="$(process_executable "$pid" "$expected" || true)"
  if [[ -z "$exe" ]]; then
    printf '%s\n' "pid $pid executable is not $expected"
    return 1
  fi
  local exe_real expected_real
  exe_real="$(real_path "$exe")"
  expected_real="$(real_path "$expected")"
  if [[ "$exe_real" != "$expected_real" ]]; then
    printf '%s\n' "pid $pid executable is $exe_real, expected $expected_real"
    return 1
  fi
  local found=0 other="" line
  while IFS= read -r line; do
    [[ -n "$line" ]] || continue
    found=$((found + 1))
    if [[ "$line" != "$pid" ]]; then
      other="$line"
    fi
  done < <(pids_for_executable "$expected" "${3:-}")
  if [[ -n "$other" ]]; then
    printf '%s\n' "$expected_real is also pid $other (drive pid is $pid)"
    return 1
  fi
  if [[ "$found" -ne 1 ]]; then
    printf '%s\n' "expected exactly one process for $expected_real, found $found"
    return 1
  fi
  if [[ -n "${3:-}" || -n "${4:-}" ]]; then
    local identity
    identity="$(verify_drive_identity_reason "$pid" "$expected" "${3:-}" "${4:-}" || true)"
    if [[ -n "$identity" ]]; then
      printf '%s\n' "$identity"
      return 1
    fi
  fi
  return 0
}

status_field() {
  python3 -c 'import sys; parts=sys.argv[1].strip().split("\t"); i=int(sys.argv[2]); print(parts[i-1] if 0 < i <= len(parts) else "")' "$1" "$2"
}

# Observation line from observe_status:
# pid, AXSelected (yes/no), menu position "x,y" or "-", menu size "w,h" or "-", window count.
# Open when AXSelected is yes, or the status item's menu has an on-screen position
# and a positive size. A closed menu still exposes its items; that count is not a
# field here and must not decide this. A 0,0 position is not on screen.
status_menu_open() {
  local line="$1"
  local selected pos size width height x y
  selected="$(status_field "$line" 2)"
  if [[ "$selected" == "yes" ]]; then
    return 0
  fi
  pos="$(status_field "$line" 3)"
  size="$(status_field "$line" 4)"
  [[ "$pos" =~ ^[0-9]+,[0-9]+$ ]] || return 1
  [[ "$size" =~ ^[0-9]+,[0-9]+$ ]] || return 1
  x="${pos%%,*}"
  y="${pos#*,}"
  width="${size%%,*}"
  height="${size#*,}"
  # y = 0 is the menu-bar edge. A closed menu that still reports a size uses 0,0.
  [[ "$y" -gt 0 && "$width" -gt 0 && "$height" -gt 0 ]]
}

status_open_fields() {
  local line="$1"
  printf '%s\t%s\t%s\t%s\n' \
    "$(status_field "$line" 2)" \
    "$(status_field "$line" 3)" \
    "$(status_field "$line" 4)" \
    "$(status_field "$line" 5)"
}

# Self-check deletes only its own /tmp/cookie-m0.<token> directory.
# /tmp/cookie-m0-decoy.<token> belongs to the decoy cleanup, not this one.
drive_temp_data_dir() {
  local dir="$1"
  local base
  case "$dir" in
    /tmp/cookie-m0-decoy.*)
      return 0
      ;;
    /tmp/cookie-m0.*)
      base="${dir#/tmp/}"
      case "$base" in
        */*) return 0 ;;
      esac
      printf '%s\n' "$dir"
      ;;
  esac
}
