#!/bin/sh
# Entrypoint of the Agent Army image. The image runs as the node user. Some
# platforms mount volumes owned by root and can only start the container as
# root to write them (Railway: RAILWAY_RUN_UID=0). Started as root, this gives
# the data folder (and WORK_DIR, when set) to node once and drops to node;
# started as any other user (the default USER node, Kubernetes runAsUser,
# Heroku), it runs the command as is.
#
# Cloud Run's worker job sets its own command (node dist/worker.js), which
# replaces this entrypoint; it runs as node, the image's user.
set -eu
if [ "$(id -u)" = "0" ]; then
  for dir in "${DATA_DIR:-/data}" ${WORK_DIR:+"$WORK_DIR"}; do
    # Never the whole filesystem, whatever the variables say.
    if [ "$dir" = "/" ]; then continue; fi
    mkdir -p "$dir" || { echo "[entrypoint] cannot create $dir" >&2; continue; }
    if [ "$(stat -c %u "$dir")" != "$(id -u node)" ]; then
      chown -R node:node "$dir" || echo "[entrypoint] cannot give $dir to the node user; the server may not be able to write it" >&2
    fi
  done
  exec setpriv --reuid=node --regid=node --init-groups -- "$@"
fi
exec "$@"
