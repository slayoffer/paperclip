#!/bin/sh
set -e

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
    exec "$@"
fi

# Adjust the node user's UID/GID if they differ from the runtime request
identity_changed=false
if [ "$(id -u node)" -ne "$PUID" ]; then
    echo "Updating node UID to $PUID"
    usermod -o -u "$PUID" node
    identity_changed=true
fi

if [ "$(id -g node)" -ne "$PGID" ]; then
    echo "Updating node GID to $PGID"
    groupmod -o -g "$PGID" node
    usermod -g "$PGID" node
    identity_changed=true
fi

# Check only the home and two directory levels during normal startup.
# A complete scan of healthy workspaces can delay server startup for minutes.
# Repair the complete tree after an identity change or a shallow mismatch.
# Operators can request deep repair after a restore with PAPERCLIP_REPAIR_OWNERSHIP=1.
home_dir="${PAPERCLIP_HOME:-/paperclip}"
if [ -d "$home_dir" ]; then
    if [ "$identity_changed" = true ] || [ "${PAPERCLIP_REPAIR_OWNERSHIP:-0}" = 1 ]; then
        chown -R node:node "$home_dir"
    else
        # Keep the probe outside a condition so set -e preserves find failures.
        ownership_mismatch=$(find "$home_dir" -maxdepth 2 \( ! -user node -o ! -group node \) -print -quit)
        if [ -n "$ownership_mismatch" ]; then
            chown -R node:node "$home_dir"
        fi
    fi
fi

exec gosu node "$@"
