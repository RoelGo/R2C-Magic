#!/usr/bin/env bash
# Adjusts the runtime user to the host-provided PUID/PGID, fixes ownership of
# the data directory, then drops privileges and execs the given command.
#
# This is the LinuxServer.io-style pattern Unraid expects: the container starts
# as root, chowns the bind-mounted appdata share (owned by nobody:users =
# 99:100 on Unraid) to the requested ids, then runs the app as that user so
# better-sqlite3 can create/open the SQLite file inside DATA_DIR.
#
# Defaults (1001/1001) match the image's baked-in `nextjs` user, so a plain
# `docker run` with no PUID/PGID keeps working unchanged.
set -euo pipefail

PUID="${PUID:-1001}"
PGID="${PGID:-1001}"
DATA_DIR="${DATA_DIR:-/app/data}"

# If we're not root (e.g. compose set `user:`), we can't chown or drop —
# just run the command as whoever we already are.
if [ "$(id -u)" != "0" ]; then
  exec "$@"
fi

# Align the `nextjs` group/user with the requested ids (idempotent).
if [ "$(getent group nodejs | cut -d: -f3)" != "$PGID" ]; then
  groupmod -o -g "$PGID" nodejs
fi
if [ "$(id -u nextjs)" != "$PUID" ]; then
  usermod -o -u "$PUID" nextjs
fi

# Ensure the data dir exists and is writable by the runtime user. `|| true`
# guards against read-only or root-squashed mounts where chown may fail but
# ownership is already correct.
mkdir -p "$DATA_DIR"
chown -R "$PUID:$PGID" "$DATA_DIR" 2>/dev/null || true

exec gosu "$PUID:$PGID" "$@"
