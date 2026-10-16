#!/usr/bin/env bash
# One tick of the automatic deploy of the race board (phase E; not installed yet).
#
#   /opt/bigospeedrun-board/ops/auto-deploy.sh
#
# bigospeedrun-board-autodeploy.timer runs it as root five minutes after the last tick
# ends. It is the site's ops/self-host/auto-deploy.sh (bigospeedrun/site 7e4dbea) for the
# board's own compose project `bigospeedrun-board`: its own lock, hold file, stopped
# marker, failed list and status.json (the same fields and words as Hosted Isomux), so one
# dead-man reader works for both. There is no build on the VPS: .github/workflows/image.yml
# tests, builds and pushes the image to GHCR and moves the `main` tag to it. A tick reads
# that tag's digest; a new digest is the target. It pulls by digest, swaps with compose,
# checks, and rolls back by itself.
#
# The board has a database, so the tick adds a migration guard before the swap: when the
# new image adds a file in db/migrations, it deploys only after an off-box backup pull whose
# snapshot is later than the time the tick first saw the target AND at most 30 minutes old
# (so a pull from before a long hold does not count). The backup host's pulls are the only
# proof: the dump program writes $pull_marker only for the bosbackup login, and only after
# the backup host has verified and published the copy and sent back its ciphertext SHA-256.
# Until then the tick ends `waiting` in phase `backup`; on the backup host
# bos-board-backup-gate sees that in the health read and starts a pull, so the copy from
# before the migration is a normal verified backup there.
#
# A new migration whose first non-blank line (after a UTF-8 BOM) matches `--\s*manual\b`,
# in any case, stops with manual_deploy_needed. The tick never runs it on its own: an
# operator either deploys it by hand, or writes the target digest into $state/manual-ok,
# which makes the tick run it unattended (board-migrate on the swap) after the off-box pull.
#
# Operator override, for a migration image while the backup host is down: write the exact
# target digest (sha256:...) into $state/backup-override. The tick then deploys that one
# digest without waiting for the off-box pull (manual migrations still need manual-ok) and
# deletes the file when it uses it. The tick never writes this file; nothing else does
# either. Take a local copy of the database first if you can.
#
# Migrations are forward-only and the previous image's migrate step skips the rows it does
# not know, so a rollback runs on the new schema. But a migration that ran may have changed
# data, so a rollback of an image that added a migration also writes the stopped marker:
# nothing deploys again until a person has checked the database and deleted it.
#
# tick_error_since is kept while ticks fail (tick_error) and deleted by the first tick that
# gets past its reads with any other result.
#
# Every tick also checks the socket directories (socket-dirs.sh --check): their group must
# be wg-caddy's gid now, which is dynamic (DynamicUser), and equal BOARD_SOCKET_GID.
#
# Per-host values come from $env_dir/board-auto-deploy.env (0600), plain KEY=value, never run:
#   BOARD_IMAGE_REPO      ghcr.io/bigospeedrun/board
#   BOARD_GITHUB_REPO     bigospeedrun/board
#   BOARD_IMAGE_WORKFLOW  image.yml
#   BOARD_TAG             the tag to follow; optional, default main. A rehearsal follows
#                         rehearsal-good, rehearsal-bad or rehearsal-manual
#                         (image-rehearsal.yml), which never move main.
# $root/release.env holds BOARD_IMAGE=<repo>@sha256:<digest> (this script rewrites only that
# line), BOARD_SOCKET_GID and, for the kill switch, BOARD_WRITES=off. The other lines stay.
# For a local run and the tests: BOARD_ROOT, BOARD_ENV_DIR, BOARD_UNIT_DIR, BOARD_SYSTEMCTL,
# BOARD_DOCKER, BOARD_REGISTRY, BOARD_GITHUB_API, BOARD_PROBE (a command that prints the
# running image digest, instead of asking Docker), BOARD_SOCKET_DIR, BOARD_PULL_MARKER,
# BOARD_SOCKET_CHECK (a command instead of socket-dirs.sh --check).
set -euo pipefail
umask 077

main() {
  env_dir=${BOARD_ENV_DIR:-/etc/bigospeedrun}
  root=${BOARD_ROOT:-/opt/bigospeedrun-board}
  unit_dir=${BOARD_UNIT_DIR:-/etc/systemd/system}
  systemctl=${BOARD_SYSTEMCTL:-systemctl}
  docker=${BOARD_DOCKER:-docker}
  registry=${BOARD_REGISTRY:-https://ghcr.io}
  api=${BOARD_GITHUB_API:-https://api.github.com}
  sockets=${BOARD_SOCKET_DIR:-/run/bigospeedrun-board}
  pull_marker=${BOARD_PULL_MARKER:-/var/lib/bos-board-backup/last-pull.json}
  here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
  socket_check=${BOARD_SOCKET_CHECK:-$here/socket-dirs.sh --check}
  state=$root/auto-deploy

  result=error phase=start target="" deployed="" waiting=false units=unchecked migration_added=false
  mkdir -p "$state/attempts"
  trap write_status EXIT

  config || return 0
  deployed=$(deployed_commit) || deployed=""

  exec 9>"$root/deploy.lock"
  if ! flock -n 9; then
    result=locked phase=lock
    return 0
  fi
  converge_units

  if [[ -e $state/stopped ]]; then
    result=stopped phase=marker
    return 0
  fi
  if [[ -e $env_dir/board-auto-deploy.hold ]]; then
    result=held phase=marker
    return 0
  fi
  # The first install is by hand: release.env names the image that runs.
  if [[ ! -f $root/release.env || ! -f $root/compose.board.yml ]]; then
    result=refused phase=install
    return 0
  fi
  deployed=$(deployed_commit) || {
    result=refused phase=current
    return 0
  }

  if ! $socket_check >/dev/null; then
    tick_error sockets "the socket directories do not match wg-caddy's group (socket-dirs.sh --check)"
    return 0
  fi
  select_target || {
    clear_tick_error
    return 0
  }
  guard_migrations || {
    clear_tick_error
    return 0
  }
  clear_tick_error
  deploy_target
}

say() { printf '%s board auto-deploy: %s\n' "$(date -u +%FT%TZ)" "$*"; }

config() {
  local file=$env_dir/board-auto-deploy.env line key value
  [[ -d $env_dir && ! -L $env_dir && -O $env_dir && $(stat -c %a "$env_dir") == 700 ]] || {
    phase=config
    say "FAIL $env_dir must be a directory owned by this user, mode 0700"
    return 1
  }
  [[ -f $file && ! -L $file && -O $file && $(stat -c %a "$file") == 600 ]] || {
    phase=config
    say "FAIL $file must be a file owned by this user, mode 0600"
    return 1
  }
  image="" repo="" workflow="" tag=main
  while IFS= read -r line || [[ -n $line ]]; do
    [[ -z $line || $line == \#* ]] && continue
    key=${line%%=*} value=${line#*=}
    case $key in
    BOARD_IMAGE_REPO) image=$value ;;
    BOARD_GITHUB_REPO) repo=$value ;;
    BOARD_IMAGE_WORKFLOW) workflow=$value ;;
    BOARD_TAG) tag=$value ;;
    esac
  done <"$file"
  [[ $image =~ ^[a-z0-9.-]+(:[0-9]+)?/[a-z0-9._/-]+$ && $repo =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ && $workflow =~ ^[A-Za-z0-9_.-]+\.ya?ml$ && $tag =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$ ]] || {
    phase=config
    say "FAIL $file must name BOARD_IMAGE_REPO (registry/path), BOARD_GITHUB_REPO (owner/repo) and BOARD_IMAGE_WORKFLOW (file name); BOARD_TAG must be a tag"
    return 1
  }
  image_path=${image#*/}
}

# The installed units follow this directory's copies, as in Hosted's auto-deploy.sh.
converge_units() {
  local name
  for name in bigospeedrun-board-autodeploy.service bigospeedrun-board-autodeploy.timer; do
    if [[ ! -f $unit_dir/$name ]]; then
      units=absent
      return 0
    fi
  done
  for name in bigospeedrun-board-autodeploy.service bigospeedrun-board-autodeploy.timer; do
    cmp -s "$here/$name" "$unit_dir/$name" && continue
    : >"$state/units-pending"
    if ! install -m 644 "$here/$name" "$unit_dir/$name"; then
      units=error
      say "FAIL could not install $name"
      return 0
    fi
  done
  if [[ -e $state/units-pending ]]; then
    if ! "$systemctl" daemon-reload || ! "$systemctl" restart bigospeedrun-board-autodeploy.timer; then
      units=error
      say "FAIL the units did not reload"
      return 0
    fi
    rm -f "$state/units-pending"
    say "units: installed this directory's copies"
  fi
  units=ok
}

release_digest() { sed -n 's/^BOARD_IMAGE=.*@\(sha256:[0-9a-f]\{64\}\)$/\1/p' "$1" 2>/dev/null; }

deployed_commit() {
  local commit
  commit=$(cat "$root/release.commit" 2>/dev/null) || return 1
  [[ $commit =~ ^[0-9a-f]{40}$ && -n $(release_digest "$root/release.env") ]] || return 1
  echo "$commit"
}

tick_error() {
  result=tick_error phase=$1
  [[ -f $state/tick-error-since ]] || date -u +%FT%TZ >"$state/tick-error-since"
  say "FAIL $2"
}

# A tick that got past the registry, API and migration reads ends the error streak.
clear_tick_error() { [[ $result == tick_error ]] || rm -f "$state/tick-error-since"; }

# One conditional request: the newest run of the image workflow on main. A 304 reuses the
# saved body and does not count against the API rate limit. Prints the run's status.
image_run_status() {
  local etag code tmp
  local -a conditional=()
  tmp=$(mktemp "$state/.run.XXXXXX")
  etag=$(cat "$state/github.etag" 2>/dev/null || true)
  [[ -n $etag && -f $state/github.json ]] && conditional=(-H "If-None-Match: $etag")
  code=$(curl -sS -o "$tmp" -D "$tmp.headers" -w '%{http_code}' --max-time 20 \
    -H 'Accept: application/vnd.github+json' -H 'X-GitHub-Api-Version: 2022-11-28' \
    "${conditional[@]}" "$api/repos/$repo/actions/workflows/$workflow/runs?branch=main&per_page=1") || code=000
  case $code in
  200)
    mv "$tmp" "$state/github.json"
    tr -d '\r' <"$tmp.headers" | sed -n 's/^[Ee][Tt][Aa][Gg]: *//p' >"$state/github.etag"
    ;;
  304) rm -f "$tmp" ;;
  *)
    rm -f "$tmp" "$tmp.headers"
    return 1
    ;;
  esac
  rm -f "$tmp.headers"
  python3 -I -c 'import json,sys; runs=json.load(open(sys.argv[1])).get("workflow_runs") or [{}]; print(runs[0].get("status") or "none")' "$state/github.json"
}

# The digest the followed tag points to (a HEAD request; anonymous pull token).
main_digest() {
  local token digest
  token=$(curl -sS --max-time 20 "$registry/token?scope=repository:$image_path:pull" |
    python3 -I -c 'import json,sys; print(json.load(sys.stdin)["token"])') || return 1
  digest=$(curl -sS -I --max-time 20 -H "Authorization: Bearer $token" \
    -H 'Accept: application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json' \
    "$registry/v2/$image_path/manifests/$tag" | tr -d '\r' | sed -n 's/^[Dd]ocker-[Cc]ontent-[Dd]igest: *\(sha256:[0-9a-f]\{64\}\)$/\1/p') || return 1
  [[ -n $digest ]] || return 1
  echo "$digest"
}

select_target() {
  local status attempts
  if ! status=$(image_run_status); then
    tick_error api "the image workflow runs could not be read"
    return 1
  fi
  if ! digest=$(main_digest); then
    tick_error registry "the registry's $tag tag could not be read"
    return 1
  fi
  if [[ $status != completed && $status != none ]]; then
    waiting=true
    [[ -f $state/waiting-since ]] || date -u +%FT%TZ >"$state/waiting-since"
  else
    rm -f "$state/waiting-since"
  fi
  if [[ $digest == "$(release_digest "$root/release.env")" ]]; then
    if $waiting; then result=waiting phase=image_runs; else result=up_to_date phase=select; fi
    return 1
  fi
  if grep -qx "$digest" "$state/failed" 2>/dev/null; then
    result=failed_target phase=select
    return 1
  fi
  # A pull can fail for a passing reason (network, registry). Two more ticks, then the
  # digest is marked failed.
  if ! "$docker" pull --quiet "$image@$digest" >/dev/null; then
    attempts=$(($(cat "$state/attempts/$digest" 2>/dev/null || echo 0) + 1))
    echo "$attempts" >"$state/attempts/$digest"
    if ((attempts >= 3)); then
      result=failed phase=pull
      echo "$digest" >>"$state/failed"
      rm -f "$state/attempts/$digest"
    else
      result=build_failed phase=pull
    fi
    return 1
  fi
  target=$("$docker" image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image@$digest") || target=""
  if [[ ! $target =~ ^[0-9a-f]{40}$ ]]; then
    result=refused phase=label
    target=""
    say "$digest has no commit label: not deployed"
    return 1
  fi
  return 0
}

# "<file>\t<first non-blank line>" for each migration in an image, read with no network:
# a UTF-8 BOM and blank lines before it are skipped, the line is trimmed.
migrations_of() {
  "$docker" run --rm --network none --entrypoint node "$1" -e '
const fs = require("fs");
for (const f of fs.readdirSync("db/migrations").filter(n => n.endsWith(".sql")).sort()) {
  const text = fs.readFileSync("db/migrations/" + f, "utf8").replace(/^\uFEFF/, "");
  const line = text.split(/\r?\n/).find(l => l.trim() !== "") || "";
  process.stdout.write(f + "\t" + line.trim().replace(/[\t\r]/g, " ") + "\n");
}'
}

# `--\s*manual\b`, in any case, at the start of a migration's first line.
is_manual() {
  local re='^--[[:space:]]*manual([^[:alnum:]_]|$)' found=1
  shopt -s nocasematch
  [[ $1 =~ $re ]] && found=0
  shopt -u nocasematch
  return $found
}

guard_migrations() {
  local old new added name first since snap fresh_after
  phase=migrations
  if ! old=$(migrations_of "$image@$(release_digest "$root/release.env")") || ! new=$(migrations_of "$image@$digest"); then
    tick_error migrations "the migration lists could not be read"
    return 1
  fi
  added=$(comm -13 <(cut -f1 <<<"$old" | sort) <(cut -f1 <<<"$new" | sort))
  if [[ -z $added ]]; then
    rm -f "$state/backup-wanted"
    return 0
  fi
  migration_added=true
  while IFS=$'\t' read -r name first; do
    grep -qxF -- "$name" <<<"$added" || continue
    if is_manual "$first" && [[ $(cat "$state/manual-ok" 2>/dev/null) != "$digest" ]]; then
      result=manual_deploy_needed
      say "$name is marked -- manual: the tick does not run it. Deploy $target by hand, or write $digest to $state/manual-ok to make the tick run it unattended after an off-box backup pull"
      return 1
    fi
  done <<<"$new"
  # The time this target first needed a backup; a pull must start after it.
  [[ $(sed -n 1p "$state/backup-wanted" 2>/dev/null) == "$digest" ]] ||
    printf '%s\n%s\n' "$digest" "$(date -u +%FT%TZ)" >"$state/backup-wanted"
  since=$(sed -n 2p "$state/backup-wanted")
  if [[ $(cat "$state/backup-override" 2>/dev/null) == "$digest" ]]; then
    rm -f "$state/backup-override" "$state/backup-wanted" "$state/waiting-since"
    waiting=false
    say "$target adds a migration: OVERRIDE by $state/backup-override, deploying with no off-box backup pull"
    return 0
  fi
  snap=$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["snapshot_utc"])' "$pull_marker" 2>/dev/null) || snap=""
  [[ $snap =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] || snap=""
  fresh_after=$(date -u -d '30 minutes ago' +%FT%TZ)
  # All three are UTC times in the same format, so the text order is the time order. The
  # pull must be later than the first sight and at most 30 minutes old.
  if [[ -z $snap || ! $snap > $since || $snap < $fresh_after ]]; then
    result=waiting phase=backup waiting=true
    echo "$since" >"$state/waiting-since"
    say "$target adds a migration: waiting for an off-box backup pull after $since and after $fresh_after"
    return 1
  fi
  rm -f "$state/backup-wanted" "$state/waiting-since"
  waiting=false
  say "$target adds a migration: off-box backup pull at $snap"
}

compose() { "$docker" compose -p bigospeedrun-board -f "$root/compose.board.yml" --env-file "$root/release.env" "$@"; }

# The long-running services. board-migrate runs as their dependency on every `up`.
up() { compose up -d --wait --wait-timeout 180 board-db board-api board-auth board-egress >/dev/null 2>&1; }

# Which image digest runs healthy now: prints it, or fails.
running_digest() {
  local service id health digest="" one code
  if [[ -n ${BOARD_PROBE:-} ]]; then
    "$BOARD_PROBE"
    return
  fi
  for service in board-api board-auth; do
    id=$(compose ps -q "$service") || return 1
    [[ -n $id ]] || return 1
    health=$("$docker" inspect --format '{{.State.Health.Status}}' "$id") || return 1
    [[ $health == healthy ]] || return 1
    one=$("$docker" inspect --format '{{.Config.Image}}' "$id") || return 1
    [[ -z $digest || $digest == "${one##*@}" ]] || return 1
    digest=${one##*@}
  done
  # What Caddy reaches: a feed page on the API socket, the account page on the auth socket.
  curl -fsS --max-time 10 --unix-socket "$sockets/api/api.sock" -o /dev/null 'http://localhost/api/posts?board=3sum&limit=1' || return 1
  code=$(curl -sS --max-time 10 --unix-socket "$sockets/auth/auth.sock" -o /dev/null -w '%{http_code}' http://localhost/auth/account) || return 1
  [[ $code =~ ^[1-4][0-9][0-9]$ ]] || return 1
  echo "$digest"
}

deploy_target() {
  local previous_commit=$deployed previous_digest running
  phase=deploy
  previous_digest=$(release_digest "$root/release.env")
  say "deploying $target ($digest) over $deployed"
  date -u +%FT%TZ >"$state/attempt-at"
  echo "$target" >"$state/attempt-target"
  cp "$root/release.env" "$root/previous.env"
  # Keep the other lines (BOARD_SOCKET_GID, BOARD_WRITES); replace only the image.
  {
    grep -v '^BOARD_IMAGE=' "$root/release.env" || true
    printf 'BOARD_IMAGE=%s@%s\n' "$image" "$digest"
  } >"$root/release.env.tmp"
  mv "$root/release.env.tmp" "$root/release.env"

  if up && running=$(running_digest) && [[ $running == "$digest" ]]; then
    echo "$target" >"$root/release.commit"
    result=deployed phase='done'
    deployed=$target
    rm -f "$state/attempts/$digest"
  else
    say "$target did not run healthy: rolling back to $previous_commit"
    mv "$root/previous.env" "$root/release.env"
    if up && running=$(running_digest) && [[ $running == "$previous_digest" ]]; then
      result=rolled_back phase=health
      echo "$digest" >>"$state/failed"
      if $migration_added; then
        stop "$target added a migration, which may have run before the rollback to $previous_commit; check the database"
      fi
    else
      result=rollback_failed phase=check
      stop "the rollback to $previous_commit does not run healthy"
    fi
  fi
  echo "$result" >"$state/attempt-result"
}

# Nothing unattended runs again until an operator deletes the marker.
stop() {
  date -u +%FT%TZ >"$state/stopped"
  say "STOPPED $1; delete $state/stopped once the board is recovered"
}

# The same fields, order and encoding as Hosted Isomux's status.json.
write_status() {
  local tmp
  tmp=$(mktemp "$state/.status.XXXXXX") || return 0
  {
    printf '{"tick_at":"%s",' "$(date -u +%FT%TZ)"
    printf '"deployed":%s,' "$(json_or_null "$deployed")"
    printf '"result":"%s","phase":"%s",' "$result" "$phase"
    printf '"target":%s,' "$(json_or_null "$target")"
    printf '"stopped":%s,' "$([[ -e $state/stopped ]] && echo true || echo false)"
    printf '"held":%s,' "$([[ -e $env_dir/board-auto-deploy.hold ]] && echo true || echo false)"
    printf '"waiting":%s,' "$waiting"
    printf '"waiting_since":%s,' "$(json_or_null "$($waiting && cat "$state/waiting-since" 2>/dev/null)")"
    printf '"tick_error_since":%s,' "$(json_or_null "$(cat "$state/tick-error-since" 2>/dev/null)")"
    printf '"units":"%s",' "$units"
    printf '"last_attempt":{"at":%s,"target":%s,"result":%s}}\n' \
      "$(json_or_null "$(cat "$state/attempt-at" 2>/dev/null)")" \
      "$(json_or_null "$(cat "$state/attempt-target" 2>/dev/null)")" \
      "$(json_or_null "$(cat "$state/attempt-result" 2>/dev/null)")"
  } >"$tmp"
  mv "$tmp" "$state/status.json"
}

# Every value here is a commit, a timestamp or a fixed word: nothing to escape.
json_or_null() { [[ -n $1 ]] && printf '"%s"' "$1" || printf 'null'; }

main "$@"
