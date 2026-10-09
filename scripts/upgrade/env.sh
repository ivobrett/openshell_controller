# Source this before running nemoclaw / openshell by hand on a gateway host:
#   . /opt/openshell-controller/scripts/upgrade/env.sh
#
# It reproduces the environment the controller's systemd unit gives those
# CLIs. A bare `sudo -i` shell is missing XDG_RUNTIME_DIR, so `systemctl
# --user` cannot reach root's user manager; NemoClaw >= v0.0.130 then takes
# its "systemd user manager is unavailable" path, which can move the gateway
# to an alternate port and strand the controller on 8080.
export HOME=/root
export OPENSHELL_GATEWAY="${OPENSHELL_GATEWAY:-nemoclaw}"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/0}"
export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=/run/user/0/bus}"
_node_bin="$(ls -d /root/.nvm/versions/node/*/bin 2>/dev/null | sort -V | tail -1)"
export PATH="${_node_bin:+$_node_bin:}/root/.local/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
unset _node_bin
