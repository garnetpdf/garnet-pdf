#!/usr/bin/env bash
# Builds the Mac download on a Mac: release/Garnet-PDF-<version>-mac.dmg and -mac.zip, one app for
# Apple silicon and Intel Macs.
#
# With a signing certificate (CSC_LINK and CSC_KEY_PASSWORD: a "Developer ID Application" certificate
# as a .p12 file; CSC_LINK is the file as base64 text, or its path) the app and the disk image are
# signed, the app with the hardened runtime. With an App Store Connect key as well (APPLE_API_KEY,
# APPLE_API_KEY_ID, APPLE_API_ISSUER; APPLE_API_KEY is the path of the .p8 file, or its text) Apple
# checks the app and the disk image ("notarises" them) and the proof is attached to both ("stapled"),
# so that the download opens on any Mac without a warning.
#
# Without a certificate the app gets a local signature only. It runs on the Mac that built it and on
# test machines; other people's Macs will refuse it. That build is for testing, never for the website.
set -euo pipefail
cd "$(dirname "$0")/.."
if [ "$(uname -s)" != "Darwin" ]; then
  echo "dist-mac.sh must run on a Mac (the disk image and the signature need macOS)." >&2
  exit 1
fi

npm run notices
npm run build

version="$(node -p "require('./package.json').version")"
app="release/mac-universal/Garnet PDF.app"
dmg="release/Garnet-PDF-${version}-mac.dmg"
zip="release/Garnet-PDF-${version}-mac.zip"
rm -f "$dmg" "$zip"

json_field() {
  node -e 'let s="";process.stdin.on("data",(d)=>(s+=d)).on("end",()=>{try{console.log(JSON.parse(s)[process.argv[1]]||"")}catch{console.log("")}})' "$1"
}

# What differs between the three kinds of build goes into a small settings file on top of
# electron-builder.yml (true and false must reach electron-builder as such, not as words).
key_file=""
if [ -n "${CSC_LINK:-}" ]; then
  kind="signed"
  settings='"dmg": { "sign": true }, "mac": { "notarize": false }'
  if [ -n "${APPLE_API_KEY:-}" ]; then
    kind="signed and notarised"
    : "${APPLE_API_KEY_ID:?APPLE_API_KEY_ID is needed with APPLE_API_KEY}"
    : "${APPLE_API_ISSUER:?APPLE_API_ISSUER is needed with APPLE_API_KEY}"
    # Build machines keep the key itself in the variable, not the path of a file: write it to one.
    if [ ! -f "$APPLE_API_KEY" ]; then
      key_file="$(mktemp -d)/AuthKey_${APPLE_API_KEY_ID}.p8"
      trap 'rm -f "$key_file"' EXIT
      if printf '%s' "$APPLE_API_KEY" | grep -q "BEGIN PRIVATE KEY"; then
        printf '%s\n' "$APPLE_API_KEY" > "$key_file"
      else
        printf '%s' "$APPLE_API_KEY" | base64 --decode > "$key_file"
      fi
      chmod 600 "$key_file"
      export APPLE_API_KEY="$key_file"
    fi
    settings='"dmg": { "sign": true }'
  fi
else
  kind="test build with a local signature"
  # No certificate: never pick one up from this Mac by accident, sign locally, and leave out the
  # hardened runtime (without a team it refuses the app's own frameworks) and Apple's check.
  export CSC_IDENTITY_AUTO_DISCOVERY=false
  unset CSC_LINK CSC_KEY_PASSWORD CSC_NAME
  unset APPLE_API_KEY APPLE_API_KEY_ID APPLE_API_ISSUER APPLE_ID APPLE_APP_SPECIFIC_PASSWORD
  settings='"mac": { "identity": "-", "hardenedRuntime": false, "notarize": false }'
fi
mkdir -p release
printf '{ "extends": "electron-builder.yml", %s }\n' "$settings" > release/mac-config.json
echo "Building the Mac download: $kind"
npx electron-builder --config release/mac-config.json --mac dmg zip --universal --publish never

[ -d "$app" ] || { echo "The app was not built: $app" >&2; exit 1; }
[ -f "$dmg" ] || { echo "The disk image was not built: $dmg" >&2; exit 1; }
[ -f "$zip" ] || { echo "The zip was not built: $zip" >&2; exit 1; }

# The signature must hold for every part of the app. For a build that goes to people this stops the
# script; for a test build it is reported and the files are kept, so that the cause can be looked at.
if ! codesign --verify --deep --strict --verbose=2 "$app"; then
  if [ "$kind" = "test build with a local signature" ]; then
    echo "WARNING: the local signature does not verify for every part of the app." >&2
  else
    echo "The signature of the app does not verify." >&2
    exit 1
  fi
fi

if [ "$kind" = "signed and notarised" ]; then
  # electron-builder had Apple check the app and attached the proof to it before it made the disk
  # image and the zip. The disk image is a file of its own: Apple checks it too, then it gets the proof.
  result="$(xcrun notarytool submit "$dmg" --key "$APPLE_API_KEY" --key-id "$APPLE_API_KEY_ID" \
    --issuer "$APPLE_API_ISSUER" --wait --timeout 30m --output-format json)"
  echo "$result"
  status="$(printf '%s' "$result" | json_field status)"
  if [ "$status" != "Accepted" ]; then
    id="$(printf '%s' "$result" | json_field id)"
    if [ -n "$id" ]; then
      xcrun notarytool log "$id" --key "$APPLE_API_KEY" --key-id "$APPLE_API_KEY_ID" \
        --issuer "$APPLE_API_ISSUER" || true
    fi
    echo "Apple did not accept the disk image (status: ${status:-unknown})." >&2
    exit 1
  fi
  xcrun stapler staple "$dmg"
  xcrun stapler validate "$dmg"
  xcrun stapler validate "$app"
  # What a Mac decides when someone opens the download.
  spctl --assess --type open --context context:primary-signature --verbose=2 "$dmg"
  spctl --assess --type execute --verbose=2 "$app"
fi

{
  echo "kind: $kind"
  echo "version: $version"
  echo "processors: $(lipo -archs "$app/Contents/MacOS/Garnet PDF")"
  echo "minimum macOS: $(/usr/libexec/PlistBuddy -c 'Print :LSMinimumSystemVersion' "$app/Contents/Info.plist")"
  echo "signature:"
  codesign --display --verbose=2 "$app" 2>&1 | sed 's/^/  /'
  echo "permissions asked of macOS (entitlements):"
  codesign --display --entitlements - "$app" 2>/dev/null | sed 's/^/  /' || true
  for file in "$dmg" "$zip"; do
    echo "$(basename "$file"): $(stat -f %z "$file") bytes, sha256 $(shasum -a 256 "$file" | cut -d' ' -f1)"
  done
} | tee release/mac-build.txt
