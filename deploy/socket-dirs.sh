#!/usr/bin/env bash
# The board's socket directories, with the group of the shared Caddy (phase E; not
# installed yet). wg-caddy is a DynamicUser unit: its gid is not fixed, and the name
# resolves (nss-systemd) only while wg-caddy runs. So the group is resolved by NAME each
# time, never written as a number into a shared file.
#
#   socket-dirs.sh           (ExecStartPre of bigospeedrun-board.service, and every deploy
#                            tick) create or fix /run/bigospeedrun-board/{api,auth}:
#                            root:<wg-caddy gid>, 2770. Prints one line per directory it
#                            created or changed, nothing when both were right.
#   socket-dirs.sh --check   change nothing; fail if a directory has another group or mode
#
# Both fail loudly when wg-caddy's gid is not BOARD_SOCKET_GID in release.env: the
# containers join that group (group_add), so a changed gid needs a new BOARD_SOCKET_GID
# and a restart of the board, not a silent fix. For the tests: BOARD_ROOT,
# BOARD_SOCKET_DIR, BOARD_GETENT.
set -euo pipefail
root=${BOARD_ROOT:-/opt/bigospeedrun-board}
sockets=${BOARD_SOCKET_DIR:-/run/bigospeedrun-board}
getent=${BOARD_GETENT:-getent}
fail() { echo "FAIL socket-dirs: $*" >&2; exit 1; }

gid=$("$getent" group wg-caddy | cut -d: -f3) || fail "group wg-caddy does not resolve (is wg-caddy running?)"
[[ $gid =~ ^[0-9]+$ ]] || fail "group wg-caddy has no numeric gid"
want=$(sed -n 's/^BOARD_SOCKET_GID=\([0-9][0-9]*\)$/\1/p' "$root/release.env" 2>/dev/null)
[[ $gid == "$want" ]] || fail "wg-caddy's gid is $gid but release.env has BOARD_SOCKET_GID=${want:-unset}: set BOARD_SOCKET_GID=$gid, then restart bigospeedrun-board.service"
for name in api auth; do
  dir=$sockets/$name
  if [[ ${1:-} == --check ]]; then
    [[ -d $dir && ! -L $dir && $(stat -c '%u:%g %a' "$dir") == "0:$gid 2770" ]] ||
      fail "$dir is not root:$gid mode 2770"
  else
    [[ ! -L $dir ]] || fail "$dir is a symlink"
    before=$(stat -c '%u:%g %a' "$dir" 2>/dev/null) || before=absent
    [[ $before == "0:$gid 2770" ]] && continue
    mkdir -p "$dir"
    chown "root:$gid" "$dir"
    chmod 2770 "$dir"   # after chown, which can clear the setgid bit
    echo "fixed $dir: was $before, now 0:$gid 2770"
  fi
done
