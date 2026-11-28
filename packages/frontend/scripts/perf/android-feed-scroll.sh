#!/usr/bin/env bash
# Release-build feed scroll measurement on a real Android device (issue #1103).
#
# Usage: android-feed-scroll.sh <label> [runs=3] [swipes=40]
#   ADB           adb binary (default: adb). From WSL, point it at the Windows
#                 adb.exe that owns the USB device.
#   ADB_SERIAL    device serial (optional).
#   OUT_DIR       where results go (default: ./feed-scroll-results).
#
# Install the release APK first (adb install -r app-release.apk). The app opens
# on the For You feed; signed out is fine, since anonymous readers paginate.
#
# Per run (after one discarded warm-up run):
#   1. cold start, 18 s to load the first page;
#   2. DRAG phase: <swipes> slow 1300 px drags (700 ms, so no momentum), which
#      scroll the same distance on every build and make runs comparable;
#      reports frames, janky %, p90/p99 frame time (gfxinfo), RSS (meminfo)
#      and CPU ticks per thread (/proc/<pid>/task/*/stat, 10 ms each):
#      mqt_v_js is the JS thread (React, Fabric commit and Yoga layout),
#      the process-named thread is the UI thread;
#   3. BLANK phase: 12 fast flings with a screenshot during each, reporting the
#      tallest band of pure background inside the feed area. A band >= 300 px
#      is a row the list had not drawn yet.
#
# Compare two builds by interleaving them (A, B, A, B): the live feed changes
# over time, and same-window runs cancel that out.
set -euo pipefail

LABEL=${1:?label}; RUNS=${2:-3}; SWIPES=${3:-40}
ADB_BIN=${ADB:-adb}
ADB_ARGS=()
[ -n "${ADB_SERIAL:-}" ] && ADB_ARGS=(-s "$ADB_SERIAL")
adb_() { "$ADB_BIN" "${ADB_ARGS[@]}" "$@"; }
PKG=earth.mention.app
OUT=${OUT_DIR:-./feed-scroll-results}/$LABEL
mkdir -p "$OUT"
HERE=$(cd "$(dirname "$0")" && pwd)

threads() {
  adb_ shell "for t in /proc/$1/task/*; do echo \$(cat \$t/comm | tr ' ' '_') \$(cut -d')' -f2 \$t/stat | awk '{print \$12+\$13}'); done" \
    | awk '{a[$1]+=$2} END {for (k in a) print k, a[k]}' | sort
}

cold_start() {
  adb_ shell am force-stop "$PKG"; sleep 2
  adb_ shell am start -n "$PKG/.MainActivity" >/dev/null; sleep 18
}

for r in $(seq 0 "$RUNS"); do
  cold_start
  PID=$(adb_ shell pidof "$PKG" | tr -d '\r')
  [ -z "$PID" ] && { echo "run $r: app not running"; continue; }
  threads "$PID" > "$OUT/threads0-$r.txt"
  adb_ shell dumpsys gfxinfo "$PKG" reset >/dev/null
  for _ in $(seq 1 "$SWIPES"); do adb_ shell input swipe 540 1700 540 400 700; sleep 0.6; done
  sleep 2
  threads "$PID" > "$OUT/threads1-$r.txt"
  adb_ shell dumpsys gfxinfo "$PKG" > "$OUT/gfx-$r.txt"
  adb_ shell dumpsys meminfo "$PKG" > "$OUT/mem-$r.txt"
  [ "$r" -eq 0 ] && continue
  CPU=$(join "$OUT/threads0-$r.txt" "$OUT/threads1-$r.txt" | awk '{d=$3-$2; if (d>0) print $1"="d}' | sort -t= -k2 -rn | head -3 | tr '\n' ' ')
  echo "drag $r: frames=$(grep -m1 'Total frames rendered' "$OUT/gfx-$r.txt" | awk -F': ' '{print $2}')" \
    "janky=$(grep -m1 'Janky frames:' "$OUT/gfx-$r.txt" | awk -F': ' '{print $2}')" \
    "p90=$(grep -m1 '^90th percentile' "$OUT/gfx-$r.txt" | awk '{print $3}')" \
    "p99=$(grep -m1 '^99th percentile' "$OUT/gfx-$r.txt" | awk '{print $3}')" \
    "rssKB=$(grep 'TOTAL RSS' "$OUT/mem-$r.txt" | awk '{print $6}')" \
    "cpuTicks[$CPU]"
done

for r in 1 2; do
  cold_start
  for i in $(seq 1 12); do
    adb_ shell input swipe 540 1900 540 300 60
    adb_ exec-out screencap -p > "$OUT/fling-$r-$i.png"
    sleep 1.2
  done
done
for f in "$OUT"/fling-*.png; do
  ffmpeg -loglevel error -y -i "$f" -f rawvideo -pix_fmt gray "${f%.png}.raw"
done
python3 "$HERE/blank-band.py" "$OUT"/fling-*.raw
