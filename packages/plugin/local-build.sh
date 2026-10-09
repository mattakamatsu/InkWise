#!/usr/bin/env bash
# Build the .snplg on this Mac with the toolchain installed outside Homebrew's
# formulae (an Apple Silicon Temurin JDK in ~/Library/Java, the Android SDK in
# ~/Library/Android/sdk). CI does the same on Linux; see .github/workflows/ci.yml.
#
#   ./local-build.sh            # stamps a dev version, builds build/outputs/Inkwise-<version>.snplg
#   ./local-build.sh --no-stamp # keep the version in PluginConfig.json as it is
set -euo pipefail
cd "$(dirname "$0")"

export JAVA_HOME="${JAVA_HOME:-$(/usr/libexec/java_home -v 21 2>/dev/null || echo "$HOME/Library/Java/JavaVirtualMachines/temurin-21.jdk/Contents/Home")}"
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$PATH"
# The plugin host runs the Metro bundle, so build it without the dev server.
export CI=1

[[ -x "$JAVA_HOME/bin/java" ]] || { echo "No JDK at $JAVA_HOME. See docs/LOCAL-BUILD.md." >&2; exit 1; }
[[ -d "$ANDROID_HOME/platforms/android-35" ]] || { echo "Android platform 35 missing under $ANDROID_HOME. See docs/LOCAL-BUILD.md." >&2; exit 1; }

echo "JDK: $("$JAVA_HOME/bin/java" -version 2>&1 | head -1)"
echo "Android SDK: $ANDROID_HOME"

# Core's declarations are what the plugin typechecks against.
(cd ../.. && npm run build -w @inkwise/core >/dev/null)

if [[ "${1:-}" != "--no-stamp" ]]; then
  # Local builds get a version from the clock, so each one installs as an upgrade
  # over the last (the device compares versionCode). Two-digit year, day of year,
  # hour and minute: 262822115 for 2026-10-09 21:15, which fits Android's 32-bit
  # versionCode and always exceeds a CI run number.
  run="$(date +%y%j%H%M)"
  (cd ../.. && node scripts/stamp-plugin-version.mjs "$run" "$(git rev-parse --short HEAD)")
  # The stamp edits tracked files; put them back once the package exists.
  trap 'git checkout -q -- PluginConfig.json package.json src/buildInfo.ts' EXIT
fi

npm run typecheck
bash ./buildPlugin.sh

version="$(node -p "require('./PluginConfig.json').versionName")"
cp build/outputs/Inkwise.snplg "build/outputs/Inkwise-$version.snplg"
echo
echo "Built build/outputs/Inkwise-$version.snplg"
unzip -l "build/outputs/Inkwise-$version.snplg" | tail -n +2 | head -20
grep -q 'com.rnfs.RNFSPackage' build/generated/PluginConfig.json && echo "reactPackages includes react-native-fs: ok" || { echo "react-native-fs missing from reactPackages" >&2; exit 1; }
