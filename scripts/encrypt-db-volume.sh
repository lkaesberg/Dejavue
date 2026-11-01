#!/usr/bin/env bash
# Encrypt Dejavue's Postgres data at rest, on a self-hosted server.
#
# Postgres has no built-in encryption, so this encrypts the storage under it — the same
# thing managed providers (RDS, Supabase, …) do for their customers. The data moves into
# a LUKS2 container file that is mounted at the Docker volume's own folder, so Docker,
# Coolify and the compose files keep using the same volume and need no changes. The
# official pgvector image stays as it is.
#
# The key is a passphrase: either one you paste from your password manager or one this
# script generates for you to save there. It is also written to a key file on the server
# so the volume unlocks by itself at boot; the password-manager copy is how you get back
# in if that file is ever lost.
#
# Run as root on the server (e.g. Coolify → Servers → localhost → Terminal):
#   bash encrypt-db-volume.sh setup    [--volume NAME] [--size 20G]
#   bash encrypt-db-volume.sh status   [--volume NAME]
#   bash encrypt-db-volume.sh cleanup  [--volume NAME]   # delete the unencrypted copies
#   bash encrypt-db-volume.sh rollback [--volume NAME]   # undo setup (only before cleanup)
set -eEuo pipefail

NAME=dejavuepg                       # device-mapper name; also tags our crypttab/fstab lines
IMG_DIR=/var/lib/dejavue-crypt
IMG=$IMG_DIR/pgdata.img              # the encrypted container file
KEY_DIR=/etc/luks-keys
KEY=$KEY_DIR/$NAME.key               # unlocks the container at boot
DUMP_GLOB='/root/dejavue-pre-encryption-*.dump'
MARK="# $NAME: Dejavue database encryption (scripts/encrypt-db-volume.sh)"

# How far setup got, so a failure can say (or do) the right thing.
#   none    — nothing changed
#   created — the container exists, nothing else touched: removed automatically
#   stopped — Dejavue is stopped and/or the data moved: `rollback` restores it
PHASE=none

info() { echo "→ $*"; }
ok() { echo "✓ $*"; }

on_fail() {
  case $PHASE in
    created)
      cryptsetup close "$NAME" 2>/dev/null || true
      rm -f "$IMG"
      echo "  Nothing was changed; the half-made container was removed." >&2
      ;;
    stopped)
      echo "  Your original data is untouched (at $DATA, or at $DATA.plain-old if it was moved)." >&2
      echo "  Run: bash $0 rollback   — it restores it and starts Dejavue again." >&2
      ;;
  esac
  PHASE=none
}

die() {
  echo "✗ $*" >&2
  on_fail
  exit 1
}

usage() {
  grep '^#   bash' "$0" | sed 's/^#   /  /'
  exit 1
}

CMD=${1:-}
[ -n "$CMD" ] || usage
shift
VOL=
SIZE=20G
while [ $# -gt 0 ]; do
  case $1 in
    --volume) VOL=${2:?--volume needs a name}; shift 2 ;;
    --size) SIZE=${2:?--size needs a value like 20G}; shift 2 ;;
    *) usage ;;
  esac
done

[ "$(id -u)" -eq 0 ] || die "run this as root"
command -v docker >/dev/null || die "docker not found"

# The Postgres volume: `<coolify-uuid>_dejavue-pgdata` under Coolify,
# `<project>_dejavue_pgdata` with plain docker compose.
if [ -z "$VOL" ]; then
  mapfile -t found < <(docker volume ls -q | grep -E 'dejavue[-_]pgdata$' || true)
  [ "${#found[@]}" -eq 1 ] || die "found ${#found[@]} Dejavue Postgres volumes (${found[*]:-none}); pick one with --volume"
  VOL=${found[0]}
fi
DATA=$(docker volume inspect -f '{{.Mountpoint}}' "$VOL" 2>/dev/null) || die "no Docker volume named $VOL"
OLD=$DATA.plain-old

# The Dejavue stack: the container using the volume (Postgres), plus everything else in
# its compose project (bot, worker, web, the one-shot migrate).
pg_container() { docker ps -a --filter "volume=$VOL" --format '{{.Names}}' | head -n1; }
pg_running() { docker ps --filter "volume=$VOL" --format '{{.Names}}' | head -n1; }
project_of() { docker inspect -f '{{ index .Config.Labels "com.docker.compose.project" }}' "$1"; }
in_project() { # $1 project, $2 "running" or "exited"
  docker ps -a --filter "label=com.docker.compose.project=$1" --filter "status=$2" --format '{{.Names}}'
}

pg_env() { docker exec "$1" printenv "$2"; }

# Exact row count of every table, as one line. Compared before and after the move.
table_counts() {
  local c=$1
  docker exec "$c" psql -U "$(pg_env "$c" POSTGRES_USER)" -d "$(pg_env "$c" POSTGRES_DB)" -Atc \
    "select coalesce(string_agg(format('%s.%s=%s', schemaname, tablename,
       (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', schemaname, tablename), false, true, '')))[1]::text),
       ' ' order by schemaname, tablename), '')
     from pg_tables where schemaname not in ('pg_catalog', 'information_schema')"
}

wait_healthy() {
  local c=$1 u d
  u=$(pg_env "$c" POSTGRES_USER)
  d=$(pg_env "$c" POSTGRES_DB)
  for _ in $(seq 60); do
    if docker exec "$c" pg_isready -q -U "$u" -d "$d" 2>/dev/null; then return 0; fi
    sleep 1
  done
  die "Postgres in $c did not become ready within 60s"
}

is_encrypted_mount() { [ "$(findmnt -n -o SOURCE --mountpoint "$DATA" 2>/dev/null)" = "/dev/mapper/$NAME" ]; }

# ---------------------------------------------------------------------------
setup() {
  [ -d /run/systemd/system ] || die "systemd is required (it unlocks the volume at boot)"
  if ! command -v cryptsetup >/dev/null; then
    command -v apt-get >/dev/null || die "install cryptsetup first"
    info "installing cryptsetup"
    apt-get update -qq && apt-get install -y -qq cryptsetup >/dev/null
  fi
  for c in findmnt fallocate mkfs.ext4 chattr diff numfmt base64 shred; do
    command -v "$c" >/dev/null || die "missing command: $c"
  done

  if findmnt -n --mountpoint "$DATA" >/dev/null; then die "$DATA is already a mount point — run: bash $0 status"; fi
  if [ -e "$IMG" ]; then die "$IMG already exists — run: bash $0 status"; fi
  if [ -e "$OLD" ]; then die "$OLD exists from an earlier run — run: bash $0 rollback or bash $0 cleanup"; fi

  local pg
  pg=$(pg_running)
  [ -n "$pg" ] || die "the Postgres container using $VOL isn't running — start Dejavue first"

  # The empty folder left under the mount is made immutable, so Postgres fails instead of
  # creating a fresh empty database if the volume is ever not mounted. Check that works here.
  local probe
  probe=$(mktemp -d "$(dirname "$DATA")/.chattr-probe.XXXX")
  if ! chattr +i "$probe" 2>/dev/null; then
    rmdir "$probe"
    die "chattr +i isn't supported under $(dirname "$DATA")"
  fi
  chattr -i "$probe"
  rmdir "$probe"

  install -d -m 700 "$IMG_DIR"
  local used size avail
  used=$(du -sb "$DATA" | cut -f1)
  size=$(numfmt --from=iec "$SIZE")
  avail=$(df --output=avail -B1 "$IMG_DIR" | tail -n1)
  [ "$size" -gt $((used * 2)) ] || die "--size $SIZE is too small for $(numfmt --to=iec "$used") of data; use at least twice that"
  [ "$avail" -gt $((size + used)) ] || die "not enough free disk: need $(numfmt --to=iec $((size + used))), have $(numfmt --to=iec "$avail")"

  # --- the passphrase, which must end up in the password manager -----------------
  local pass confirm
  echo
  read -rsp "Paste a passphrase from your password manager, or press Enter to generate one: " pass
  echo
  if [ -z "$pass" ]; then
    pass=$(head -c 32 /dev/urandom | base64 | tr -d '\n')
    echo
    echo "════ Save this passphrase in your password manager now ════"
    echo "$pass"
    echo "═══════════════════════════════════════════════════════════"
    read -rsp "Then paste it back from the password manager to confirm: " confirm
  else
    [ "${#pass}" -ge 20 ] || die "use a passphrase of at least 20 characters"
    read -rsp "Paste it once more to confirm: " confirm
  fi
  echo
  [ "$pass" = "$confirm" ] || die "the passphrases don't match — nothing was changed"

  local project others=()
  project=$(project_of "$pg")
  if [ -n "$project" ]; then
    mapfile -t others < <(in_project "$project" running | grep -vx "$pg" || true)
  fi
  echo
  echo "About to encrypt:"
  echo "  volume      $VOL"
  echo "  data        $DATA ($(numfmt --to=iec "$used"))"
  echo "  container   $IMG ($SIZE)"
  echo "  key file    $KEY"
  echo "  stopping    $pg ${others[*]:-}"
  echo "Dejavue is offline from the stop until the data is copied (usually under a minute)."
  local answer
  read -rp "Type 'encrypt' to continue: " answer
  [ "$answer" = encrypt ] || die "aborted — nothing was changed"

  trap 'echo "✗ setup failed at line $LINENO" >&2; on_fail' ERR

  info "creating the encrypted container (Dejavue is still running)"
  PHASE=created
  fallocate -l "$SIZE" "$IMG"
  chmod 600 "$IMG"
  printf '%s' "$pass" | cryptsetup luksFormat --type luks2 --batch-mode --key-file - "$IMG"
  printf '%s' "$pass" | cryptsetup open --key-file - "$IMG" "$NAME"
  mkfs.ext4 -q -L "$NAME" "/dev/mapper/$NAME"

  PHASE=stopped
  if [ "${#others[@]}" -gt 0 ]; then
    info "stopping the app: ${others[*]}"
    docker stop "${others[@]}" >/dev/null
  fi
  local before dump
  before=$(table_counts "$pg")
  dump="/root/dejavue-pre-encryption-$(date +%Y%m%d-%H%M%S).dump"
  info "safety dump → $dump"
  (umask 077; docker exec "$pg" pg_dump -U "$(pg_env "$pg" POSTGRES_USER)" -d "$(pg_env "$pg" POSTGRES_DB)" -Fc >"$dump")
  info "stopping Postgres"
  docker stop "$pg" >/dev/null

  info "copying the data into the encrypted filesystem"
  local tmp
  tmp=$(mktemp -d)
  mount "/dev/mapper/$NAME" "$tmp"
  rmdir "$tmp/lost+found"
  cp -a "$DATA"/. "$tmp"/
  chown --reference="$DATA" "$tmp"
  chmod --reference="$DATA" "$tmp"
  if ! diff -r "$DATA" "$tmp" >/dev/null; then
    umount "$tmp"
    die "the copy differs from the original"
  fi
  umount "$tmp"
  rmdir "$tmp"
  ok "copy verified"

  mv "$DATA" "$OLD"
  mkdir "$DATA"
  chattr +i "$DATA"

  info "setting up the unlock at boot"
  install -d -m 700 "$KEY_DIR"
  (umask 077; printf '%s' "$pass" >"$KEY")
  chmod 400 "$KEY"
  touch /etc/crypttab
  local stamp
  stamp=$(date +%Y%m%d-%H%M%S)
  cp -p /etc/crypttab "/etc/crypttab.bak-$stamp"
  cp -p /etc/fstab "/etc/fstab.bak-$stamp"
  # nofail: a failed unlock never blocks the server's boot (the immutable folder then
  # keeps Postgres from starting). x-systemd.before: mounted before any container starts.
  printf '%s\n%s %s %s luks,nofail\n' "$MARK" "$NAME" "$IMG" "$KEY" >>/etc/crypttab
  printf '%s\n/dev/mapper/%s %s ext4 defaults,nofail,x-systemd.before=docker.service 0 2\n' \
    "$MARK" "$NAME" "$DATA" >>/etc/fstab
  systemctl daemon-reload

  # Re-open through systemd and fstab, exactly as a reboot will, so the boot path is tested now.
  cryptsetup close "$NAME"
  systemctl start "systemd-cryptsetup@$NAME.service"
  mount "$DATA"
  is_encrypted_mount || die "$DATA is not mounted from /dev/mapper/$NAME"
  [ -f "$DATA/PG_VERSION" ] || die "$DATA has no PG_VERSION after mounting"
  ok "unlocks and mounts through the boot configuration"

  info "starting Postgres"
  docker start "$pg" >/dev/null
  wait_healthy "$pg"
  local after
  after=$(table_counts "$pg")
  [ "$before" = "$after" ] || die "row counts differ after the move (before: $before / after: $after)"
  ok "every table has the same row count as before"
  if [ "${#others[@]}" -gt 0 ]; then
    info "starting the app: ${others[*]}"
    docker start "${others[@]}" >/dev/null
  fi
  trap - ERR
  PHASE=none

  cat <<EOF

✓ Dejavue's database is now encrypted at rest.

  It unlocks automatically at boot with $KEY.
  Your password manager holds the same passphrase. If the key file is ever lost:
    printf '%s' 'PASSPHRASE' > $KEY && chmod 400 $KEY

Next:
  1. Check that the bot and the website work.
  2. Optional but recommended: reboot once, then run: bash $0 status
  3. Delete the unencrypted copies: bash $0 cleanup
     (until then, bash $0 rollback restores the previous state)
EOF
}

# ---------------------------------------------------------------------------
status() {
  echo "volume       $VOL"
  echo "data         $DATA"
  if is_encrypted_mount; then
    ok "mounted from the encrypted container /dev/mapper/$NAME"
  else
    echo "✗ not mounted from the encrypted container"
  fi
  if command -v cryptsetup >/dev/null && cryptsetup status "$NAME" >/dev/null 2>&1; then
    ok "container unlocked ($(cryptsetup status "$NAME" | awk '/cipher:/ {print $2}'))"
  else
    echo "✗ container $NAME is not unlocked"
  fi
  if [ -f "$KEY" ]; then ok "key file $KEY present"; else echo "✗ no key file at $KEY"; fi
  if grep -q "^$NAME " /etc/crypttab 2>/dev/null; then ok "unlock at boot configured (/etc/crypttab)"; else echo "✗ no /etc/crypttab entry"; fi
  if grep -q "^/dev/mapper/$NAME " /etc/fstab; then ok "mount at boot configured (/etc/fstab)"; else echo "✗ no /etc/fstab entry"; fi
  if [ -e "$OLD" ]; then echo "! unencrypted copy still at $OLD — remove it with: bash $0 cleanup"; fi
  if compgen -G "$DUMP_GLOB" >/dev/null; then echo "! unencrypted safety dump(s) in /root — removed by: bash $0 cleanup"; fi
  local pg
  pg=$(pg_running)
  if [ -n "$pg" ]; then ok "Postgres running ($pg)"; else echo "✗ no running Postgres container uses $VOL"; fi
}

# ---------------------------------------------------------------------------
cleanup() {
  is_encrypted_mount || die "$DATA isn't mounted from the encrypted container — not deleting anything"
  [ -n "$(pg_running)" ] || die "Postgres isn't running — check Dejavue works before deleting the copies"
  echo "This deletes the unencrypted copies:"
  if [ -e "$OLD" ]; then echo "  $OLD"; fi
  if compgen -G "$DUMP_GLOB" >/dev/null; then compgen -G "$DUMP_GLOB" | sed 's/^/  /'; fi
  echo "After this, rollback is no longer possible."
  local answer
  read -rp "Type 'delete' to continue: " answer
  [ "$answer" = delete ] || die "aborted"
  rm -rf "$OLD"
  if compgen -G "$DUMP_GLOB" >/dev/null; then
    compgen -G "$DUMP_GLOB" | while read -r f; do shred -u "$f"; done
  fi
  # On SSDs and virtual disks deleted blocks aren't overwritten; trimming hands them back.
  fstrim -av >/dev/null 2>&1 || true
  ok "unencrypted copies deleted"
}

# ---------------------------------------------------------------------------
rollback() {
  if [ ! -e "$OLD" ] && is_encrypted_mount; then
    die "the encrypted volume holds the only copy (cleanup already ran) — rollback isn't possible"
  fi
  if [ ! -e "$OLD" ] && [ ! -e "$IMG" ] && ! grep -q "$NAME" /etc/fstab; then
    die "nothing to roll back"
  fi
  if [ -e "$OLD" ]; then
    echo "This restores the database as it was when setup ran. Anything written since is lost."
    local answer
    read -rp "Type 'rollback' to continue: " answer
    [ "$answer" = rollback ] || die "aborted"
  fi

  local pg project others=()
  pg=$(pg_container)
  project=$([ -n "$pg" ] && project_of "$pg" || true)
  if [ -n "$project" ]; then
    mapfile -t others < <(in_project "$project" running | grep -vx "$pg" || true)
    if [ "${#others[@]}" -gt 0 ]; then docker stop "${others[@]}" >/dev/null; fi
  fi
  if [ -n "$pg" ]; then docker stop "$pg" >/dev/null 2>&1 || true; fi

  if findmnt -n --mountpoint "$DATA" >/dev/null; then umount "$DATA"; fi
  if [ -e "$OLD" ]; then
    chattr -i "$DATA" 2>/dev/null || true
    rmdir "$DATA"
    mv "$OLD" "$DATA"
  fi
  if command -v cryptsetup >/dev/null && cryptsetup status "$NAME" >/dev/null 2>&1; then
    cryptsetup close "$NAME"
  fi
  sed -i "/$NAME/d" /etc/fstab
  if [ -f /etc/crypttab ]; then sed -i "/$NAME/d" /etc/crypttab; fi
  systemctl daemon-reload 2>/dev/null || true
  rm -f "$IMG" "$KEY"
  ok "restored $DATA and removed the encrypted container and its key"

  if [ -n "$pg" ]; then
    docker start "$pg" >/dev/null
    wait_healthy "$pg"
    # Start whatever of the stack is stopped — including the one-shot migrate, which just
    # finds nothing to do again.
    if [ -n "$project" ]; then
      mapfile -t others < <(in_project "$project" exited | grep -vx "$pg" || true)
      if [ "${#others[@]}" -gt 0 ]; then docker start "${others[@]}" >/dev/null; fi
    fi
    ok "Dejavue started again"
  fi
}

case $CMD in
  setup) setup ;;
  status) status ;;
  cleanup) cleanup ;;
  rollback) rollback ;;
  *) usage ;;
esac
