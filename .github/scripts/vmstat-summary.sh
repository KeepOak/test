#!/usr/bin/env bash
# Experiment only: average CPU use of a share from a vmstat log.
awk 'NR>2{n++; us+=$13; sy+=$14; id+=$15; wa+=$16; r+=$1} END{printf "samples=%d avg run-queue=%.1f us=%.0f%% sy=%.0f%% idle=%.0f%% wait=%.0f%%\n", n, r/n, us/n, sy/n, id/n, wa/n}' "$1"
cat "$1"
