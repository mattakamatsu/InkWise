# Building the plugin on a Mac

The `.snplg` needs a JDK 21 and the Android SDK (platform 35, build-tools
35.0.0), because `react-native-fs` is native code. CI installs those on Linux
(`.github/workflows/ci.yml`); this is the same setup on macOS, done without
`sudo` and without Homebrew formulae.

## Why not `brew install openjdk@21`

On an Apple Silicon Mac whose Homebrew is the Intel build under Rosetta
(`brew --prefix` says `/usr/local`), formulae compile from source for hours.
Casks are plain downloads and are fine; formulae are not.

## One-time setup

1. **JDK 21, Apple Silicon build**, into your user Java folder, where
   `/usr/libexec/java_home` finds it. Get the current link and checksum from
   the Adoptium API and verify before extracting:

   ```bash
   curl -sS 'https://api.adoptium.net/v3/assets/latest/21/hotspot?architecture=aarch64&os=mac&image_type=jdk&vendor=eclipse' \
     | python3 -c 'import json,sys; b=json.load(sys.stdin)[0]["binary"]["package"]; print(b["link"]); print(b["checksum"])'
   ```

   Download the tarball, check `shasum -a 256`, then:

   ```bash
   mkdir -p ~/Library/Java/JavaVirtualMachines && tar -xzf jdk.tar.gz
   mv jdk-21.* ~/Library/Java/JavaVirtualMachines/temurin-21.jdk
   /usr/libexec/java_home -v 21
   ```

2. **Android command-line tools** (a zip; Homebrew's cask is fine here):

   ```bash
   brew install --cask android-commandlinetools
   ```

3. **SDK packages** into `~/Library/Android/sdk`:

   ```bash
   export JAVA_HOME=$(/usr/libexec/java_home -v 21)
   SM=/usr/local/share/android-commandlinetools/cmdline-tools/latest/bin/sdkmanager
   yes | $SM --sdk_root=$HOME/Library/Android/sdk --licenses
   $SM --sdk_root=$HOME/Library/Android/sdk --install "platforms;android-35" "build-tools;35.0.0" "platform-tools"
   ```

Nothing above touches your shell profile. `packages/plugin/local-build.sh`
sets `JAVA_HOME` and `ANDROID_HOME` itself, from those two locations.

## Build

```bash
cd packages/plugin && ./local-build.sh
```

The first run downloads Gradle 8.13 and the React Native Android artifacts
(several hundred MB) and takes a while; later runs take a minute or two. The
result is `build/outputs/Inkwise-<version>.snplg`, with the version stamped
from the clock so each build installs as an upgrade over the last. Pass
`--no-stamp` to keep the version in `PluginConfig.json`.

## Install on the Supernote

Copy the `.snplg` into `MyStyle/` on the device (USB, or the Supernote
Partner app), then on the device: **Settings → Apps → Plugins → Add Plugin**.
`docs/TESTING-ON-DEVICE.md` has the first-run checklist.

### Over USB with adb

Turning on **Settings → Security & Privacy → Sideloading** on the Supernote
is what enables `adb` over USB; there is no separate developer toggle. With
the device plugged in (a data cable, and a USB 2 port if a USB 3 one is
flaky):

```bash
cd packages/plugin && ./deploy.sh
```

pushes the newest build into `MyStyle/` and then follows the plugin's JS log
(`ReactNativeJS`), which is where `console` output and uncaught errors land.
You still add the plugin on the device the first time. `./deploy.sh --log`
only follows the log. Inkwise's own log is separate:
`MyStyle/Inkwise/inkwise-log.txt` on the device.

There is no emulator for the plugin host, so "run locally" means this loop:
build, push, tap on the device, read the log.
