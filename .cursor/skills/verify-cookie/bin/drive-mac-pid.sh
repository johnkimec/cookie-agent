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

# Distinct from 0 (ok) and 3 (open-clean skipped).
ISOLATION_REFUSAL_CODE=4

# The account's home from Directory Service. Used when the process had no
# HOME at startup. dscl is macOS. getent is Linux.
directory_service_home() {
  local home=""
  if command -v dscl >/dev/null 2>&1; then
    home="$(dscl . -read "/Users/$(id -un)" NFSHomeDirectory 2>/dev/null | awk 'NR==1 { sub(/^[^ ]+ /, ""); print; exit }' || true)"
  fi
  if [[ -z "$home" ]] && command -v getent >/dev/null 2>&1; then
    home="$(getent passwd "$(id -un)" 2>/dev/null | awk -F: 'NR==1 { print $6; exit }' || true)"
  fi
  [[ -n "$home" ]] || return 1
  printf '%s\n' "$home"
}

isolation_fail() {
  printf '%s\n' "not-ok" "refusing to launch: $*" >&2
  exit "$ISOLATION_REFUSAL_CODE"
}

# One private temp directory per run, realpath'd. Per-run HOME and data
# directories are children. Cleanup removes only a path with this marker.
ensure_isolate_root() {
  if [[ -n "${ISOLATE_ROOT:-}" ]]; then
    return 0
  fi
  local created resolved
  created="$(mktemp -d "${TMPDIR:-/tmp}/cookie-drive-isolate.XXXXXX")"
  resolved="$(real_path "$created")"
  case "$resolved" in
    *"/cookie-drive-isolate."*) ;;
    *)
      rm -rf "$created"
      isolation_fail "isolate root $resolved is not a private temp directory"
      ;;
  esac
  ISOLATE_ROOT="$resolved"
}

# Sets ISOLATE_LAST. Call it in the current shell. A command substitution
# would drop the ISOLATE_ROOT assignment on the first call.
isolate_dir() {
  local kind="$1"
  local created resolved
  ensure_isolate_root
  created="$(mktemp -d "$ISOLATE_ROOT/${kind}.XXXXXX")"
  resolved="$(real_path "$created")"
  case "$resolved" in
    "$ISOLATE_ROOT"/*) ;;
    *)
      rm -rf "$created"
      isolation_fail "isolated $kind directory escaped the private temp dir"
      ;;
  esac
  ISOLATE_LAST="$resolved"
}

remove_isolate_root() {
  local root="${1-${ISOLATE_ROOT-}}"
  [[ -n "$root" ]] || return 0
  case "$root" in
    *"/cookie-drive-isolate."*)
      rm -rf "$root"
      ;;
  esac
}

# Realpath HOME and COOKIE_DATA_DIR and compare them case-insensitively with
# the real home and with $REAL_HOME/Library/Application Support/com.johnkimec.cookie-agent.
# APFS is usually case-insensitive, so a mixed-case spelling is the same directory.
# Exit 4 before any launch when HOME is the real home, or either path is that
# data directory or inside it. Arguments override the current environment so a
# launch can pass its own HOME without changing the shell.
assert_isolated_data_dir() {
  local home="${1-${HOME-}}"
  local data="${2-${COOKIE_DATA_DIR-}}"
  local real_home="${3-${REAL_HOME-}}"
  if [[ -z "$real_home" ]]; then
    real_home="$(directory_service_home)" || isolation_fail "cannot resolve the real home"
  fi
  local reason="" code=0
  reason="$(python3 - "$home" "$data" "$real_home" <<'PY'
import os
import sys

home, data, real_home = sys.argv[1:]

def resolve(path, label):
    if path == "":
        print("%s is empty" % label)
        sys.exit(1)
    try:
        resolved = os.path.realpath(path)
    except OSError as exc:
        print("cannot realpath %s (%s): %s" % (label, path, exc))
        sys.exit(2)
    if resolved == "":
        print("cannot realpath %s (%s)" % (label, path))
        sys.exit(2)
    return resolved.rstrip("/").casefold()

def within(child, parent):
    return child == parent or child.startswith(parent + "/")

home_key = resolve(home, "HOME")
data_key = resolve(data, "COOKIE_DATA_DIR")
real_home_key = resolve(real_home, "the real home")
real_data = os.path.join(
    real_home,
    "Library",
    "Application Support",
    "com.johnkimec.cookie-agent",
)
real_data_key = resolve(real_data, "the real cookie data directory")
if home_key == real_home_key:
    print("HOME is the real home (%s)" % home)
    sys.exit(1)
if within(home_key, real_data_key):
    print("HOME is the real cookie data directory or inside it (%s)" % home)
    sys.exit(1)
if within(data_key, real_data_key):
    print("COOKIE_DATA_DIR is the real cookie data directory or inside it (%s)" % data)
    sys.exit(1)
sys.exit(0)
PY
)" || code=$?
  if [[ "$code" -eq 0 ]]; then
    return 0
  fi
  if [[ -z "$reason" ]]; then
    reason="cannot realpath HOME, COOKIE_DATA_DIR, or the real home"
  fi
  isolation_fail "$reason"
}
