#!/bin/sh
# The real update test on Linux (branch-test-linux): install the release before the newest one from
# its download, put real work in it, press its own Update button, and check what a person is left with.
# Everything lives under $RU (a throwaway HOME, temp folder and downloads); nothing of anyone's is used.
#
#   sh real-update-linux.sh setup <from-tag> <to-tag>     downloads both releases, installs the driver
#   sh real-update-linux.sh run   <scenario>              normal | corrupt | drop | kill-switch | installer
#   sh real-update-linux.sh clean                         stops everything and removes $RU
#
# Run it under the machine lock: flock -o -w 7200 /tmp/branch-linux.lock sh real-update-linux.sh run normal
set -u
RU="${RU:-/tmp/ru}"
REPO="${REPO:-stabrea/Branch-Agent}"
ASSET=Branch-Agent-linux-x64.tar.gz
export HOME="$RU/home" TMPDIR="$RU/tmp" DISPLAY="${RU_DISPLAY:-:77}"
unset XDG_CONFIG_HOME XDG_DATA_HOME XDG_CACHE_HOME XDG_RUNTIME_DIR DBUS_SESSION_BUS_ADDRESS
APP="$HOME/Applications/Branch-Agent-linux-x64"
DATA="$HOME/.config/Branch Agent/state"
SCRATCH="$TMPDIR/branch-agent-update"
D="$RU/driver/real-update-test.mjs"
say() { printf '== %s\n' "$1"; }

setup() {
  mkdir -p "$RU/dl/from" "$RU/dl/to" "$RU/driver"
  for pair in "from $1" "to $2"; do
    set -- $pair
    (cd "$RU/dl/$1" && for f in "$ASSET" "$ASSET.sha256" install-branch-agent.sh; do
      curl -fsSLO "https://github.com/$REPO/releases/download/$2/$f" 2>/dev/null || true; done
      sha256sum -c "$ASSET.sha256") || exit 1
  done
  cp "$(dirname "$0")/real-update-test.mjs" "$RU/driver/"
  (cd "$RU/driver" && npm init -y >/dev/null && npm i playwright-core@1 >/dev/null 2>&1)
}

display() { pgrep -f "Xvfb $DISPLAY" >/dev/null || { setsid nohup Xvfb "$DISPLAY" -screen 0 1440x950x24 -nolisten tcp >"$RU/xvfb.log" 2>&1 </dev/null & sleep 2; }; }

stop_all() {
  pkill -f "$HOME/Applications/" 2>/dev/null; pkill -f "$RU/home/.local/share/branch-agent" 2>/dev/null
  pkill -f "$SCRATCH/apply-update.sh" 2>/dev/null; sleep 3
}

# A person on Ubuntu 24.04 unpacks the download and, as the docs say, runs the one sudo command the
# sandbox needs (docs/configuration.md, "chrome-sandbox ... owned by root with mode 4755").
fresh() {
  stop_all; rm -rf "$HOME" "$TMPDIR"; mkdir -p "$HOME/Applications" "$TMPDIR"
  tar -xzf "$RU/dl/from/$ASSET" -C "$HOME/Applications"
  sudo chown root "$APP/chrome-sandbox" && sudo chmod 4755 "$APP/chrome-sandbox"
  (cd "$RU/driver" && node "$D" launch --exe "$APP/branch-agent" --port 9391 && node "$D" plant --data "$DATA" --out "$RU/planted.json")
}

# What is on disk afterwards: every copy of the program, and what the update left in the temp folder.
leftovers() {
  say "on disk"; ls -la "$HOME/Applications"; ls -la "$APP/chrome-sandbox" 2>&1
  for d in "$APP"*; do printf '%s: %s\n' "$d" "$(grep -m1 '"version"' "$d/resources/app/package.json" 2>/dev/null)"; done
  du -sh "$SCRATCH" 2>/dev/null; cat "$SCRATCH/apply-update.log" 2>/dev/null
}

# Starts whatever is installed again, the way a person would after a restart, and checks the work.
again() {
  expect="$1"
  (cd "$RU/driver" && node "$D" quit --data "$DATA" 2>/dev/null); stop_all
  (cd "$RU/driver" && node "$D" launch --exe "$APP/branch-agent" --port 9391 && node "$D" verify --data "$DATA" --planted "$RU/planted.json" --expect "$expect")
}

# The sandbox helper of the new copy has to be made root's again before it starts (see `fresh`).
# Harness only: pauses the hand-over while its copy finishes, runs the documented sudo step on the new
# copy, and lets it go on. Without it, the update on this Ubuntu cannot succeed (that is scenario `normal-stock`).
sandbox_step() {
  sudo setsid sh -c '
    until grep -q "copying new version" "$2" 2>/dev/null; do sleep 0.01; done
    SH=$(pgrep -f "[a]pply-update.sh" | head -1); kill -STOP "$SH"
    while pgrep -f "[c]p -Rp .*unpacked" >/dev/null; do sleep 0.05; done
    [ -e "$1.incoming/chrome-sandbox" ] && chown root "$1.incoming/chrome-sandbox" && chmod 4755 "$1.incoming/chrome-sandbox"
    kill -CONT "$SH"' sh "$APP" "$SCRATCH/apply-update.log" >"$RU/sandbox-step.log" 2>&1 </dev/null &
}

# Cuts only this app's own download connection, as a dropped network does (TCP reset).
drop_cmd() {
  printf '%s' "for p in \$(pgrep -f '$APP/branch-agent'); do ss -tnpH state established '( dport = :443 )' | grep \"pid=\$p,\" | awk '{print \$4}' | while read peer; do sudo ss -K dst \"\${peer%:*}\" dport = :443; done; done"
}

run() {
  display; say "scenario $1"
  case "$1" in
    normal-stock) fresh; (cd "$RU/driver" && node "$D" update --port 9391 --scratch "$SCRATCH"); sleep 45; leftovers
      (cd "$RU/driver" && node "$D" launch --exe "$APP/branch-agent" --port 9391) ;;
    normal) fresh; sandbox_step; (cd "$RU/driver" && node "$D" update --port 9391 --scratch "$SCRATCH"); sleep 40
      (cd "$RU/driver" && node "$D" verify --data "$DATA" --planted "$RU/planted.json" --expect "${TO_VERSION:-0.18.0}"); leftovers; again "${TO_VERSION:-0.18.0}" ;;
    corrupt) fresh; (cd "$RU/driver" && node "$D" update --port 9391 --scratch "$SCRATCH" --fault corrupt); sleep 5; leftovers; again "${FROM_VERSION:-0.17.0}" ;;
    drop) fresh; (cd "$RU/driver" && node "$D" update --port 9391 --scratch "$SCRATCH" --fault drop --drop-cmd "$(drop_cmd)"); sleep 5; leftovers; again "${FROM_VERSION:-0.17.0}" ;;
    kill-switch) fresh; (cd "$RU/driver" && node "$D" update --port 9391 --scratch "$SCRATCH" --fault kill-switch); sleep 5; leftovers; again "${FROM_VERSION:-0.17.0}" ;;
    installer) fresh; (cd "$RU/driver" && node "$D" quit --data "$DATA"); stop_all
      sh "$RU/dl/to/install-branch-agent.sh" --quiet; echo "installer exit $?"
      ls -la "$HOME/Applications" "$HOME/.local/share/branch-agent" "$HOME/.local/bin" "$HOME/.local/share/applications" 2>&1
      find "$HOME" -maxdepth 5 -name branch-agent -type f 2>/dev/null ;;
    *) echo "unknown scenario $1"; exit 2 ;;
  esac
}

case "${1:-}" in
  setup) setup "$2" "$3" ;;
  run) run "$2" ;;
  clean) stop_all; pkill -f "Xvfb $DISPLAY"; sudo rm -rf "$RU" ;;
  *) echo "usage: $0 setup <from-tag> <to-tag> | run <scenario> | clean"; exit 2 ;;
esac
