#!/bin/zsh
# Builds the BlueBubbles Private API helper (Messages, macOS 11+) from helper-src without Xcode.
# Private framework symbols (IMCore etc.) are resolved at runtime inside Messages (-undefined dynamic_lookup).
# Output: build/BlueBubblesHelper.dylib (arm64e + arm64 + x86_64, like the shipped one).
set -euo pipefail
ROOT="${0:A:h:h}"
SRC="$ROOT/helper-src/bluebubbles-helper/Messages/MacOS-11+"
OUT="$ROOT/build"
mkdir -p "$OUT"
cd "$SRC"

FILES=(
  BlueBubblesHelper/BlueBubblesHelper.m
  BlueBubblesHelper/CTBlockDescription.m
  BlueBubblesHelper/NetworkController.m
  BlueBubblesHelper/ZKSwizzle/ZKSwizzle.m
  Pods/CocoaAsyncSocket/Source/GCD/GCDAsyncSocket.m
  Pods/CocoaAsyncSocket/Source/GCD/GCDAsyncUdpSocket.m
)
[[ -f BlueBubblesHelper/PollSupport.m ]] && FILES+=(BlueBubblesHelper/PollSupport.m)

slices=()
for arch in arm64e arm64 x86_64; do
  clang -dynamiclib -arch "$arch" -mmacosx-version-min=11.5 -fobjc-arc -fmodules -O2 -Wno-everything \
    -I BlueBubblesHelper -I BlueBubblesHelper/ZKSwizzle -I Pods/CocoaAsyncSocket/Source/GCD \
    -I Pods/Headers/Public -I Pods/Headers/Public/CocoaAsyncSocket \
    "${FILES[@]}" \
    -framework Foundation -framework AppKit -framework Security -framework CFNetwork \
    -undefined dynamic_lookup -install_name @rpath/BlueBubblesHelper.dylib \
    -o "$OUT/BlueBubblesHelper-$arch.dylib"
  slices+=("$OUT/BlueBubblesHelper-$arch.dylib")
done
lipo -create "${slices[@]}" -output "$OUT/BlueBubblesHelper.dylib"
rm -f "${slices[@]}"
codesign -f -s - "$OUT/BlueBubblesHelper.dylib" 2>/dev/null || true
lipo -info "$OUT/BlueBubblesHelper.dylib"
