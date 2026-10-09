#!/usr/bin/env bash
# Push the newest .snplg to a Supernote over USB, then follow the plugin's JS log.
#
#   ./deploy.sh            # push, then tail the log
#   ./deploy.sh --no-log   # push only
#   ./deploy.sh --log      # only tail the log
#
# Needs: Settings → Security & Privacy → Sideloading turned on (that is what
# enables adb over USB on these devices) and a data-capable USB cable. After
# the push, finish on the device: Settings → Apps → Plugins → Add Plugin.
set -euo pipefail
cd "$(dirname "$0")"

ADB="${ANDROID_HOME:-$HOME/Library/Android/sdk}/platform-tools/adb"
[[ -x "$ADB" ]] || ADB="$(command -v adb || true)"
[[ -n "$ADB" ]] || { echo "adb not found; see docs/LOCAL-BUILD.md" >&2; exit 1; }

device="$("$ADB" devices | awk 'NR>1 && $2=="device" {print $1; exit}')"
if [[ -z "$device" ]]; then
  echo "No Supernote on USB. Turn on Settings → Security & Privacy → Sideloading, plug it in, and check:" >&2
  "$ADB" devices >&2
  exit 1
fi
echo "Device: $device"

if [[ "${1:-}" != "--log" ]]; then
  pkg="$(ls -t build/outputs/Inkwise-*.snplg 2>/dev/null | head -1 || true)"
  [[ -n "$pkg" ]] || { echo "No build/outputs/Inkwise-*.snplg; run ./local-build.sh first" >&2; exit 1; }
  "$ADB" -s "$device" push "$pkg" "/storage/emulated/0/MyStyle/$(basename "$pkg")"
  echo "Pushed $(basename "$pkg") to MyStyle/. On the device: Settings → Apps → Plugins → Add Plugin."
fi

if [[ "${1:-}" != "--no-log" ]]; then
  echo "Following the plugin's JS log (Ctrl-C to stop)…"
  "$ADB" -s "$device" logcat -c || true
  "$ADB" -s "$device" logcat -v time -s ReactNativeJS:V ReactNative:W AndroidRuntime:E
fi
