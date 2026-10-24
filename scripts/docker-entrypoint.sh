#!/bin/sh
set -e

# Timestamped progress lines make the pre-start phase (container start to
# the first app log line) measurable from the container log alone.
log() {
    echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) docker-entrypoint.sh: $*"
}

log "starting"

# Capture runtime UID/GID from environment variables, defaulting to 1000
PUID=${USER_UID:-1000}
PGID=${USER_GID:-1000}

# Without root we can neither remap the node user (usermod/groupmod/chown)
# nor switch users (gosu needs CAP_SETUID/CAP_SETGID), so exec directly.
# This covers Kubernetes restricted PodSecurity (runAsNonRoot + runAsUser)
# as well as platforms that assign arbitrary UIDs (e.g. OpenShift); for the
# latter a UID/GID mismatch is unfixable here, so warn instead of letting
# usermod fail cryptically and keep volume-permission issues diagnosable.
if [ "$(id -u)" -ne 0 ]; then
    if [ "$(id -u)" -ne "$PUID" ] || [ "$(id -g)" -ne "$PGID" ]; then
        echo "docker-entrypoint.sh: running unprivileged as $(id -u):$(id -g); cannot remap to requested ${PUID}:${PGID}" >&2
    fi
    log "starting app as $(id -u):$(id -g)"
    exec "$@"
fi

# Adjust the node user's UID/GID if they differ from the runtime request.
#
# `usermod -u` and `usermod -g` also re-own every file under the user's home
# directory. When that home is the app home (the data volume), the walk can
# take minutes on a large home, and the app cannot start until it ends. In
# that case the remap runs while the home points at a placeholder path that
# does not exist, so usermod changes only the account, and the ownership probe
# below repairs the complete app home when the IDs really changed.
# A passwd home outside the app home is not covered by that repair, so
# it keeps the plain usermod behavior, which re-owns it.
#
# The placeholder embeds the original home, so a boot that stops between the
# two usermod -d calls is repaired on the next start of the same container.
remap_home_prefix="/nonexistent/paperclip-uid-remap"
node_home="$(getent passwd node 2>/dev/null | cut -d: -f6 || true)"
case "$node_home" in
    "$remap_home_prefix"/*)
        node_home="${node_home#"$remap_home_prefix"}"
        echo "Restoring node home to $node_home after an interrupted remap"
        usermod -d "$node_home" node
        ;;
esac

remap_uid=0
remap_gid=0
[ "$(id -u node)" -ne "$PUID" ] && remap_uid=1
[ "$(id -g node)" -ne "$PGID" ] && remap_gid=1
app_home="${PAPERCLIP_HOME:-/paperclip}"
move_home=0
if { [ "$remap_uid" -eq 1 ] || [ "$remap_gid" -eq 1 ]; } \
    && [ -n "$node_home" ] && [ "${node_home%/}" = "${app_home%/}" ]; then
    move_home=1
    usermod -d "$remap_home_prefix$node_home" node
fi

if [ "$remap_uid" -eq 1 ]; then
    echo "Updating node UID to $PUID"
    usermod -o -u "$PUID" node
fi

if [ "$remap_gid" -eq 1 ]; then
    echo "Updating node GID to $PGID"
    groupmod -o -g "$PGID" node
    usermod -g "$PGID" node
fi

if [ "$move_home" -eq 1 ]; then
    usermod -d "$node_home" node
fi

# Check only the home and two directory levels during normal startup.
# A complete scan of healthy workspaces can delay server startup for minutes.
# Repair the complete tree after an identity change or a shallow mismatch.
# Operators can request deep repair after a restore with PAPERCLIP_REPAIR_OWNERSHIP=1.
home_dir="${PAPERCLIP_HOME:-/paperclip}"
if [ -d "$home_dir" ]; then
    needs_repair=0
    if [ "$remap_uid" -eq 1 ] || [ "$remap_gid" -eq 1 ] || [ "${PAPERCLIP_REPAIR_OWNERSHIP:-0}" = 1 ]; then
        needs_repair=1
    else
        # Keep the probe outside a condition so set -e preserves find failures.
        ownership_mismatch=$(find "$home_dir" -maxdepth 2 \( ! -user node -o ! -group node \) -print -quit)
        if [ -n "$ownership_mismatch" ]; then
            needs_repair=1
        fi
    fi
    if [ "$needs_repair" -eq 1 ]; then
        log "repairing ownership of $home_dir to node:node"
        repair_started=$(date +%s)
        chown -R node:node "$home_dir"
        log "ownership repair finished in $(( $(date +%s) - repair_started ))s"
    fi
fi

log "starting app as node"
exec gosu node "$@"
