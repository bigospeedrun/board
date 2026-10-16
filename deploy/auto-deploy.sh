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
# new image adds a file in db/migrations, the dump program (the same one the backup login
# runs) writes an encrypted dump to $backup_dir first. A failed dump is a tick_error (tried
# again on the next tick; the dead-man alerts after one hour). A new migration whose first
# line starts with `-- manual` stops with manual_deploy_needed until an operator writes the
# target digest into $state/manual-ok. Migrations are forward-only and the previous image's
# migrate step skips the rows it does not know, so a rollback runs on the new schema.
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
# running image digest, instead of asking Docker), BOARD_SOCKET_DIR, BOARD_DUMP,
# BOARD_BACKUP_DIR.
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
  dump=${BOARD_DUMP:-/usr/local/sbin/bos-board-backup-dump}
  backup_dir=${BOARD_BACKUP_DIR:-/var/backups/bigospeedrun-board}
  here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
  state=$root/auto-deploy

  result=error phase=start target="" deployed="" waiting=false units=unchecked
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

  select_target || return 0
  guard_migrations || return 0
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
  rm -f "$state/tick-error-since"
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

# "<file>\t<first line>" for each migration in an image, read with no network.
migrations_of() {
  "$docker" run --rm --network none --entrypoint sh "$1" -c \
    'cd db/migrations && for f in *.sql; do printf "%s\t%s\n" "$f" "$(head -n 1 "$f")"; done'
}

guard_migrations() {
  local old new added name first out
  phase=migrations
  if ! old=$(migrations_of "$image@$(release_digest "$root/release.env")") || ! new=$(migrations_of "$image@$digest"); then
    tick_error migrations "the migration lists could not be read"
    return 1
  fi
  added=$(comm -13 <(cut -f1 <<<"$old" | sort) <(cut -f1 <<<"$new" | sort))
  [[ -z $added ]] && return 0
  while IFS= read -r name; do
    first=$(awk -F'\t' -v n="$name" '$1 == n {print $2; exit}' <<<"$new")
    if [[ $first == "-- manual"* && $(cat "$state/manual-ok" 2>/dev/null) != "$digest" ]]; then
      result=manual_deploy_needed
      say "$name is marked -- manual: deploy $target by hand, then write $digest to $state/manual-ok"
      return 1
    fi
  done <<<"$added"
  mkdir -p "$backup_dir"
  out=$backup_dir/pre-$target.tar
  if ! "$dump" >"$out.partial"; then
    rm -f "$out.partial"
    tick_error backup "the pre-migration dump failed: $target not deployed"
    return 1
  fi
  mv "$out.partial" "$out"
  rm -f "$state/tick-error-since"
  # Keep the newest three pre-migration dumps.
  ls -1t "$backup_dir"/pre-*.tar 2>/dev/null | tail -n +4 | while IFS= read -r name; do rm -f "$name"; done
  say "pre-migration dump for $target: $out"
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
  curl -fsS --max-time 10 --unix-socket "$sockets/api/api.sock" -o /dev/null 'http://localhost/board/api/posts?board=3sum&limit=1' || return 1
  code=$(curl -sS --max-time 10 --unix-socket "$sockets/auth/auth.sock" -o /dev/null -w '%{http_code}' http://localhost/board/auth/account) || return 1
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
    else
      stop "the rollback to $previous_commit does not run healthy"
    fi
  fi
  echo "$result" >"$state/attempt-result"
}

# Nothing unattended runs again until an operator deletes the marker.
stop() {
  result=rollback_failed phase=check
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
