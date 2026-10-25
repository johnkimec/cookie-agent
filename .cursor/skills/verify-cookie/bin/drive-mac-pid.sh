# Pid checks for drive-mac. Bash 3.2. Sourced, not executed.
# A drive may touch a process only when its executable is the bundle it launched.

real_path() {
  python3 -c 'import os, sys; print(os.path.realpath(sys.argv[1]))' "$1"
}

comm_pids_named() {
  local want="$1"
  ps -ax -o pid=,comm= 2>/dev/null | awk -v want="$want" '
    NF >= 2 {
      name = $2
      n = split(name, parts, "/")
      if (parts[n] == want && !seen[$1]++) print $1
    }
  '
}

cookieagent_comm_pids() {
  comm_pids_named "CookieAgent"
}

process_comm_name() {
  local pid="$1"
  ps -p "$pid" -o comm= 2>/dev/null | awk '
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
