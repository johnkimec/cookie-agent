# shellcheck shell=bash
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
  # $5 is the space-separated set being stopped together. An extra pid for
  # this same executable is "also pid" unless it is in that set. An empty set
  # fails closed: one extra process and this pid is not signaled.
  local cohort="${5:-}"
  local found=0 outsider="" line seen_self=0
  while IFS= read -r line; do
    [[ -n "$line" ]] || continue
    found=$((found + 1))
    if [[ "$line" == "$pid" ]]; then
      seen_self=1
      continue
    fi
    case " ${cohort} " in
      *" ${line} "*) ;;
      *) outsider="$line" ;;
    esac
  done < <(pids_for_executable "$expected" "${3:-}")
  if [[ -n "$outsider" ]]; then
    printf '%s\n' "$expected_real is also pid $outsider (drive pid is $pid)"
    return 1
  fi
  if [[ "$seen_self" -ne 1 ]]; then
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
  local selected pos size width height y
  selected="$(status_field "$line" 2)"
  if [[ "$selected" == "yes" ]]; then
    return 0
  fi
  pos="$(status_field "$line" 3)"
  size="$(status_field "$line" 4)"
  [[ "$pos" =~ ^[0-9]+,[0-9]+$ ]] || return 1
  [[ "$size" =~ ^[0-9]+,[0-9]+$ ]] || return 1
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

# One absolute home, or nothing. A value that does not start with / is not a home.
absolute_home() {
  local home="$1"
  [[ "$home" == /* ]] || return 1
  printf '%s\n' "$home"
}

# dscl prints "NFSHomeDirectory: /Users/name" on one line. A home path that
# contains a space is a continuation line:
#   NFSHomeDirectory:
#    /Users/Sam Kim
read_dscl_home() {
  local home=""
  if ! command -v dscl >/dev/null 2>&1; then
    return 1
  fi
  home="$(dscl . -read "/Users/$(id -un)" NFSHomeDirectory 2>/dev/null | awk '
    NR == 1 {
      sub(/^NFSHomeDirectory:[[:space:]]*/, "")
      if ($0 != "") {
        print
        exit
      }
      next
    }
    {
      sub(/^[[:space:]]+/, "")
      sub(/[[:space:]]+$/, "")
      if ($0 != "") {
        print
        exit
      }
    }
  ' || true)"
  absolute_home "$home"
}

read_getent_home() {
  local home=""
  if ! command -v getent >/dev/null 2>&1; then
    return 1
  fi
  home="$(getent passwd "$(id -un)" 2>/dev/null | awk -F: 'NR==1 { print $6; exit }' || true)"
  absolute_home "$home"
}

# libc passwd entry. Third source, after dscl and getent.
read_passwd_home() {
  local home=""
  home="$(python3 -c 'import os, pwd; print(pwd.getpwuid(os.getuid()).pw_dir)' 2>/dev/null || true)"
  absolute_home "$home"
}

# Every account-home source, one path per line. Callers protect all of them.
account_homes() {
  local home=""
  home="$(read_dscl_home || true)"
  if [[ -n "$home" ]]; then
    printf '%s\n' "$home"
  fi
  home="$(read_getent_home || true)"
  if [[ -n "$home" ]]; then
    printf '%s\n' "$home"
  fi
  home="$(read_passwd_home || true)"
  if [[ -n "$home" ]]; then
    printf '%s\n' "$home"
  fi
}

# The account's home from Directory Service. Used when the process had no
# HOME at startup. dscl is macOS. getent is Linux. pwd.getpwuid is the third.
directory_service_home() {
  local home=""
  home="$(read_dscl_home || true)"
  if [[ -z "$home" ]]; then
    home="$(read_getent_home || true)"
  fi
  if [[ -z "$home" ]]; then
    home="$(read_passwd_home || true)"
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
  # shellcheck disable=SC2034 # callers read ISOLATE_LAST in this shell
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

# Per-run bundle ids write com.johnkimec.cookie-agent.drive.<hex>.plist.
# <hex> is one or more lowercase hex digits and nothing else. The product
# plist has no ".drive." segment and stays. A name with an extra dot, a
# non-hex character, or uppercase hex stays too.
each_drive_preference_plist() {
  local home="$1"
  local dir="$home/Library/Preferences"
  local plist pattern extglob_restore=0
  [[ -d "$dir" ]] || return 0
  if ! shopt -q extglob; then
    shopt -s extglob
    extglob_restore=1
  fi
  # The pattern is expanded at runtime, after extglob is on. It matches
  # com.johnkimec.cookie-agent.drive.<hex>.plist and no wider name.
  pattern='com.johnkimec.cookie-agent.drive.+([0-9a-f]).plist'
  # shellcheck disable=SC2086
  for plist in "$dir"/$pattern; do
    if [[ -f "$plist" ]]; then
      printf '%s\n' "$plist"
    fi
  done
  if [[ "$extglob_restore" -eq 1 ]]; then
    shopt -u extglob
  fi
}

remove_drive_preference_plists() {
  local home="$1"
  local plist
  while IFS= read -r plist; do
    [[ -n "$plist" ]] || continue
    rm -f "$plist"
  done < <(each_drive_preference_plist "$home")
}

drive_preference_plist_present() {
  local home="$1"
  local plist
  while IFS= read -r plist; do
    [[ -n "$plist" ]] || continue
    return 0
  done < <(each_drive_preference_plist "$home")
  return 1
}

# Real homes are the startup HOME and every account source (dscl, getent,
# pwd.getpwuid). A wrong startup HOME must not hide the account home.
# Case-insensitive realpath still applies. st_dev+st_ino catches a firmlink
# or bind mount whose path strings differ. A missing data directory matches
# when the deepest existing parent has that inode and the remaining path is
# the same or longer. An ancestor of the data directory inside the real home
# (for example ~/Library) is refused. A HOME inside the real home is not the
# home itself. Exit 4 before any launch.
assert_isolated_data_dir() {
  local home="${1-${HOME-}}"
  local data="${2-${COOKIE_DATA_DIR-}}"
  local startup_home="${3-${REAL_HOME-}}"
  local service_homes=""
  service_homes="$(account_homes || true)"
  if [[ -z "$startup_home" && -z "$service_homes" ]]; then
    isolation_fail "cannot resolve the real home"
  fi
  local reason="" code=0
  reason="$(python3 - "$home" "$data" "$startup_home" "$service_homes" <<'PY'
import os
import sys

home, data, startup_home, service_blob = sys.argv[1:5]
DATA_TAIL = ("Library", "Application Support", "com.johnkimec.cookie-agent")

def fold(path):
    resolved = os.path.realpath(path).rstrip("/")
    if resolved == "":
        raise OSError("empty realpath")
    return resolved.casefold()

def within(child, parent):
    return child == parent or child.startswith(parent + "/")

def stat_id(path):
    try:
        st = os.stat(path)
    except OSError:
        return None
    return (st.st_dev, st.st_ino)

def chain_ids(path):
    ids = []
    current = path
    seen = set()
    while current and current not in seen:
        seen.add(current)
        ident = stat_id(current)
        if ident is not None:
            ids.append(ident)
        parent = os.path.dirname(current.rstrip("/"))
        if not parent or parent == current:
            break
        current = parent
    return ids

def hits(ids, forbidden):
    return any(item in forbidden for item in ids)

def strict_ancestor_ids(path):
    # Skip the path itself. Existing parents only, so a missing leaf still
    # reports the directory that contains it.
    ids = []
    current = os.path.realpath(path)
    seen = set()
    skipped = False
    while current and current not in seen:
        seen.add(current)
        if skipped:
            ident = stat_id(current)
            if ident is not None:
                ids.append(ident)
        skipped = True
        parent = os.path.dirname(current.rstrip("/"))
        if not parent or parent == current:
            break
        current = parent
    return ids

def anchor(path):
    # Deepest existing parent, plus the missing suffix. Bind mounts keep
    # different path strings and the same inode, including when the leaf
    # has not been created yet.
    current = os.path.realpath(path)
    missing = []
    seen = set()
    while current and current not in seen:
        seen.add(current)
        ident = stat_id(current)
        if ident is not None:
            remaining = "/".join(reversed(missing)).casefold()
            return ident, remaining
        name = os.path.basename(current.rstrip("/"))
        if name == "":
            break
        missing.append(name)
        parent = os.path.dirname(current.rstrip("/"))
        if not parent or parent == current:
            break
        current = parent
    return None, ""

def anchor_covers(real_anchor, cand_anchor):
    rid, rrem = real_anchor
    cid, crem = cand_anchor
    if rid is None or cid is None or rid != cid:
        return False
    if crem == rrem or (rrem != "" and crem.startswith(rrem + "/")):
        return True
    # The real data directory exists. Any missing path under that inode is inside it.
    return rrem == ""

def home_relation(path, home_keys, home_inodes):
    key = fold(path)
    for home_key in home_keys:
        if key == home_key:
            return "exact"
        if key.startswith(home_key + "/"):
            return "inside"
    ident = stat_id(path)
    if ident is not None and ident in home_inodes:
        return "exact"
    if hits(chain_ids(path), home_inodes):
        return "inside"
    return ""

def inside_home(path, home_keys, home_inodes):
    key = fold(path)
    for home_key in home_keys:
        if key == home_key or key.startswith(home_key + "/"):
            return True
    return hits(chain_ids(path), home_inodes)

def is_data_ancestor(candidate, real_data_path, home_keys, home_inodes):
    cand_key = fold(candidate)
    data_key = fold(real_data_path)
    string_ancestor = cand_key != "" and data_key.startswith(cand_key + "/")
    inode_ancestor = False
    cid = stat_id(candidate)
    if cid is not None and cid in strict_ancestor_ids(real_data_path):
        inode_ancestor = True
    if not string_ancestor and not inode_ancestor:
        return False
    return inside_home(candidate, home_keys, home_inodes)

if home == "":
    print("HOME is empty")
    sys.exit(1)
if data == "":
    print("COOKIE_DATA_DIR is empty")
    sys.exit(1)

service_homes = [line for line in service_blob.splitlines() if line != ""]
real_homes = []
for raw in [startup_home] + service_homes:
    if raw and raw not in real_homes:
        real_homes.append(raw)
if not real_homes:
    print("cannot resolve the real home")
    sys.exit(2)

try:
    home_key = fold(home)
    data_key = fold(data)
except OSError as exc:
    print("cannot realpath HOME or COOKIE_DATA_DIR: %s" % exc)
    sys.exit(2)

home_keys = []
data_paths = []
home_inodes = set()
data_inodes = set()
for raw in real_homes:
    try:
        home_keys.append(fold(raw))
        data_path = raw
        for part in DATA_TAIL:
            data_path = os.path.join(data_path, part)
        fold(data_path)
        data_paths.append(data_path)
    except OSError as exc:
        print("cannot realpath a real home (%s): %s" % (raw, exc))
        sys.exit(2)
    ident = stat_id(raw)
    if ident is not None:
        home_inodes.add(ident)
    ident = stat_id(data_path)
    if ident is not None:
        data_inodes.add(ident)

try:
    relation = home_relation(home, home_keys, home_inodes)
except OSError as exc:
    print("cannot realpath HOME or COOKIE_DATA_DIR: %s" % exc)
    sys.exit(2)

if relation == "exact":
    print("HOME is the real home (%s)" % home)
    sys.exit(1)

for data_path in data_paths:
    real_data_key = fold(data_path)
    if within(home_key, real_data_key) or hits(chain_ids(home), data_inodes):
        print("HOME is the real cookie data directory or inside it (%s)" % home)
        sys.exit(1)
    if within(data_key, real_data_key) or hits(chain_ids(data), data_inodes):
        print("COOKIE_DATA_DIR is the real cookie data directory or inside it (%s)" % data)
        sys.exit(1)
    if stat_id(data) is not None and stat_id(data) in home_inodes:
        print("COOKIE_DATA_DIR is the real cookie data directory or inside it (%s)" % data)
        sys.exit(1)
    if is_data_ancestor(data, data_path, home_keys, home_inodes):
        print("COOKIE_DATA_DIR is the real cookie data directory or inside it (%s)" % data)
        sys.exit(1)
    if anchor_covers(anchor(data_path), anchor(data)):
        print("COOKIE_DATA_DIR is the real cookie data directory or inside it (%s)" % data)
        sys.exit(1)

if relation == "inside":
    print("HOME is inside the real home (%s)" % home)
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
