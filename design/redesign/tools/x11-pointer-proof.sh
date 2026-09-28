#!/bin/sh
# computer-control: Branch's Linux pointer path, and a paired computer's input (branch node), against real X11 windows
# on a hidden Xvfb display inside WSL.
# Needs Xvfb, and xdotool, xwininfo, xev, xmessage, xprop, wmctrl and openbox with their libraries unpacked under /tmp/bx/root (apt-get download
# and dpkg -x; nothing is installed). Run from WSL: sh design/redesign/tools/x11-pointer-proof.sh (after npm run build).
set -e
B=/tmp/bx
export LD_LIBRARY_PATH=$B/root/usr/lib/x86_64-linux-gnu XDG_DATA_DIRS=$B/root/usr/share XDG_CONFIG_DIRS=$B/root/etc/xdg
printf '#!/bin/sh
LD_LIBRARY_PATH=%s exec %s/root/usr/bin/xdotool "$@"
' "$LD_LIBRARY_PATH" "$B" > $B/xdotool; chmod +x $B/xdotool
printf '#!/bin/sh
LD_LIBRARY_PATH=%s exec %s/root/usr/bin/xwininfo "$@"
' "$LD_LIBRARY_PATH" "$B" > $B/xwininfo; chmod +x $B/xwininfo
for tool in xmessage wmctrl xprop; do printf '#!/bin/sh
LD_LIBRARY_PATH=%s exec %s/root/usr/bin/%s "$@"
' "$LD_LIBRARY_PATH" "$B" "$tool" > $B/$tool; chmod +x $B/$tool; done
unset WAYLAND_DISPLAY
export DISPLAY=:93
Xvfb :93 -screen 0 1280x800x24 -nolisten tcp >/tmp/bx/xvfb.log 2>&1 & XV=$!
sleep 1
$B/root/usr/bin/openbox >/tmp/bx/wm.log 2>&1 & WM=$!
sleep 1
$B/root/usr/bin/xev -geometry 400x300+100+100 -name "Branch proof A" > $B/a.log 2>&1 & A=$!
$B/root/usr/bin/xev -geometry 300x200+700+400 -name "Branch proof B" > $B/b.log 2>&1 & BB=$!
sleep 1.5
PATH=$B:$PATH node "$(dirname "$0")/x11-pointer-proof.mjs"; R=$?
kill $A $BB $WM $XV 2>/dev/null || true
exit $R
