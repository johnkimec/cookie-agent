#!/bin/bash
# PR #30 @ b34c3d9 adversarial harness for assert_isolated_data_dir. Linux box, fake homes only.
# dscl/getent are shell functions (command -v finds them) so the "directory service home" is a fixture.
set -uo pipefail
LIB="$(cd "$(dirname "$0")/bin" && pwd)/drive-mac-pid.sh"
# shellcheck source=bin/drive-mac-pid.sh
source "$LIB"
T="$(mktemp -d /tmp/pr30b-adv.XXXXXX)"
RH="$T/Users/samkim"
RD="$RH/Library/Application Support/com.johnkimec.cookie-agent"
NOGETENT="$T/nogetent-bin"; mkdir -p "$NOGETENT"; for b in awk id python3 env cat tr cut; do ln -s "$(command -v $b)" "$NOGETENT/$b"; done
mkdir -p "$RD/logs" "$T/tmp/iso/home" "$T/tmp/iso/data" "$T/tmp/with space/data dir" "$T/wrong-home"
mkdir -p "$RH/Library/Application Support/com.johnkimec.cookie-agent-old" "$RH/Library/Application Support/com.johnkimec.cookie-agent2" "$RH/scratch/iso-home"
ln -s "$RD" "$T/link1"; ln -s "$T/link1" "$T/link2"; ln -s "$T/link2" "$T/link3"
ln -s "$RH" "$T/homelink"; ln -s "$RH/Library" "$T/liblink"
DSCL_MODE=ok          # ok | empty | fail | spaces
GETENT_MODE=none      # none (macOS: no getent) | ok
dscl() { case "$DSCL_MODE" in ok) echo "NFSHomeDirectory: $RH";; empty) :;; fail) return 1;; spaces) printf 'NFSHomeDirectory:\n %s\n' "$RH";; esac; }
getent() { [[ "$GETENT_MODE" == ok ]] && echo "samkim:x:501:20::$RH:/bin/zsh"; [[ "$GETENT_MODE" == ok ]]; }
if [[ "$GETENT_MODE" == none ]]; then :; fi
# make `command -v getent` fail when GETENT_MODE=none by shadowing PATH lookup via a wrapper
_cv_getent() { :; }
run() { # label expect home data startup_home
  local label="$1" expect="$2" home="$3" data="$4" sh="${5-$RH}" out code
  if [[ "$GETENT_MODE" == none ]]; then
    out="$( (unset -f getent; PATH="$NOGETENT"; hash -r; assert_isolated_data_dir "$home" "$data" "$sh") 2>&1 )"; code=$?
  else
    out="$( (assert_isolated_data_dir "$home" "$data" "$sh") 2>&1 )"; code=$?
  fi
  local v=PASS; [[ "$expect" == refuse && $code -ne 4 ]] && v=FAIL; [[ "$expect" == allow && $code -ne 0 ]] && v=FAIL
  [[ "$expect" == note ]] && v=NOTE
  printf '%-4s expect=%-6s exit=%s dscl=%-6s getent=%-4s %-58s | %s\n' "$v" "$expect" "$code" "$DSCL_MODE" "$GETENT_MODE" "$label" "$(echo "$out" | tr '\n' ' ' | cut -c1-120)"
}
H="$T/tmp/iso/home"; D="$T/tmp/iso/data"
echo "## prior cases"
run "baseline temp HOME + temp data"           allow  "$H" "$D"
run "HOME = real home"                         refuse "$RH" "$D"
run "HOME = real home trailing slash"          refuse "$RH/" "$D"
run "HOME = real home trailing //"             refuse "$RH//" "$D"
run "HOME via .. segments"                     refuse "$RH/Library/../" "$D"
run "HOME via symlink"                         refuse "$T/homelink" "$D"
run "HOME uppercase variant"                   refuse "$T/USERS/SAMKIM" "$D"
run "HOME inside real data dir"                refuse "$RD/sub" "$D"
run "data = real data dir"                     refuse "$H" "$RD"
run "data trailing slash"                      refuse "$H" "$RD/"
run "data trailing /. and //"                  refuse "$H" "$RD//."
run "data .. segments"                         refuse "$H" "$RH/Library/Caches/../Application Support/com.johnkimec.cookie-agent"
run "data .. from inside data dir"             refuse "$H" "$RD/logs/.."
run "data 3-hop symlink chain"                 refuse "$H" "$T/link3"
run "data symlink chain + subdir"              refuse "$H" "$T/link3/logs"
run "data via symlinked parent (~/Library)"    refuse "$H" "$T/liblink/Application Support/com.johnkimec.cookie-agent"
run "data uppercase variant"                   refuse "$H" "$RH/library/application support/COM.JOHNKIMEC.COOKIE-AGENT"
run "data uppercase nonexistent subdir"        refuse "$H" "$RH/LIBRARY/Application Support/com.johnkimec.cookie-agent/x/y"
run "data with spaces (temp)"                  allow  "$H" "$T/tmp/with space/data dir"
run "sibling prefix -old"                      allow  "$H" "$RH/Library/Application Support/com.johnkimec.cookie-agent-old"
run "sibling prefix 2"                         allow  "$H" "$RH/Library/Application Support/com.johnkimec.cookie-agent2"
run "empty HOME"                               refuse "" "$D"
run "empty data"                               refuse "$H" ""
run "startup home with trailing slash"         refuse "$H" "$RD" "$RH/"
run "startup home via symlink"                 refuse "$H" "$RD" "$T/homelink"
echo "## prior blockers (B1)"
run "SPOOF: startup HOME wrong, data->real via symlink" refuse "$H" "$T/link1" "$T/wrong-home"
run "SPOOF: startup HOME wrong, data = real data dir"   refuse "$H" "$RD" "$T/wrong-home"
run "SPOOF: startup HOME wrong, HOME = real home"       refuse "$RH" "$D" "$T/wrong-home"
echo "## new cases"
run "data = parent of real data dir (App Support)"  note "$H" "$RH/Library/Application Support"
run "data = ~/Library"                              note "$H" "$RH/Library"
run "data = real home itself"                       refuse "$H" "$RH"
run "data = real home trailing slash"               refuse "$H" "$RH/"
run "data = real home uppercase"                    refuse "$H" "$T/USERS/samkim"
run "data = real home via .."                       refuse "$H" "$RH/Library/.."
run "data = /"                                      note "$H" "/"
run "HOME = parent of real home (/Users)"           note "$T/Users" "$D"
run "HOME = subdir of real home (~/scratch/iso)"    note "$RH/scratch/iso-home" "$D"
run "unset/empty startup HOME, dscl ok"             refuse "$H" "$RD" ""
run "unset/empty startup HOME, dscl ok, HOME=real"  refuse "$RH" "$D" ""
DSCL_MODE=empty
run "dscl no output, startup HOME ok, data real"    refuse "$H" "$RD"
run "dscl no output, startup HOME empty"            allow  "$H" "$D" ""
run "dscl no output + startup HOME wrong (no source)" note "$H" "$T/link1" "$T/wrong-home"
DSCL_MODE=fail
run "dscl fails, startup HOME ok, data via symlink" refuse "$H" "$T/link1"
run "dscl fails, startup HOME empty"                allow  "$H" "$D" ""
DSCL_MODE=spaces
run "dscl two-line output (home w/ spaces) + spoof" note "$H" "$T/link1" "$T/wrong-home"
DSCL_MODE=ok
GETENT_MODE=ok; DSCL_MODE=empty
run "Linux getent fallback + spoof"                 refuse "$H" "$T/link1" "$T/wrong-home"
GETENT_MODE=none; DSCL_MODE=ok
echo "## real data dir not existing yet"
mv "$RD" "$RD.moved"
run "nodata: data = real data path (string)"        refuse "$H" "$RD"
run "nodata: data uppercase"                        refuse "$H" "$RH/LIBRARY/application support/com.johnkimec.cookie-agent"
run "nodata: data via symlinked ~/Library"          refuse "$H" "$T/liblink/Application Support/com.johnkimec.cookie-agent"
run "nodata: spoof startup HOME + symlinked Library" refuse "$H" "$T/liblink/Application Support/com.johnkimec.cookie-agent" "$T/wrong-home"
mv "$RD.moved" "$RD"
echo "## bind-mount alias (firmlink stand-in)"
ALIAS="$T/System/Volumes/Data/Users/samkim"; mkdir -p "$ALIAS"
if mount --bind "$RH" "$ALIAS" 2>/dev/null; then
  ln -s "$ALIAS/Library/Application Support/com.johnkimec.cookie-agent" "$T/aliaslink"
  run "ALIAS: data via alias"                       refuse "$H" "$ALIAS/Library/Application Support/com.johnkimec.cookie-agent"
  run "ALIAS: symlink -> alias"                     refuse "$H" "$T/aliaslink"
  run "ALIAS: data missing leaf under alias"        refuse "$H" "$ALIAS/Library/Application Support/com.johnkimec.cookie-agent/new/leaf"
  run "ALIAS: data = alias home"                    refuse "$H" "$ALIAS"
  run "ALIAS: HOME = alias home"                    refuse "$ALIAS" "$D"
  run "ALIAS: HOME inside alias data dir"           refuse "$ALIAS/Library/Application Support/com.johnkimec.cookie-agent/x" "$D"
  run "ALIAS: uppercase alias path"                 refuse "$H" "$T/SYSTEM/Volumes/Data/Users/samkim/Library/Application Support/com.johnkimec.cookie-agent"
  run "ALIAS + spoofed startup HOME"                refuse "$H" "$ALIAS/Library/Application Support/com.johnkimec.cookie-agent" "$T/wrong-home"
  run "ALIAS: sibling prefix under alias"           allow  "$H" "$ALIAS/Library/Application Support/com.johnkimec.cookie-agent-old"
  mv "$RD" "$RD.moved"
  run "ALIAS + real data dir missing: alias data path" refuse "$H" "$ALIAS/Library/Application Support/com.johnkimec.cookie-agent"
  mv "$RD.moved" "$RD"
  stat -c '%n dev=%d ino=%i' "$RD" "$ALIAS/Library/Application Support/com.johnkimec.cookie-agent"
  umount "$ALIAS"
else
  echo "SKIP bind mount (not root)"
fi
rm -rf "$T"
