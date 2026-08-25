#!/usr/bin/env bash

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

info() { printf '\033[1;34m[build-apk]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[build-apk]\033[0m %s\n' "$*" >&2; }
fail() { printf '\033[1;31m[build-apk]\033[0m %s\n' "$*" >&2; exit 1; }

REQUIRED_CMDS=(
  node
  npm
  cargo
  rustup
  java
  sdkmanager
  keytool
)

missing=()
for cmd in "${REQUIRED_CMDS[@]}"; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    missing+=("$cmd")
  fi
done

if [ "${#missing[@]}" -ne 0 ]; then
  fail "Missing required command(s): ${missing[*]}"
fi

: "${ANDROID_SDK_ROOT:=${ANDROID_HOME:-}}"
if [ -z "$ANDROID_SDK_ROOT" ]; then
  fail "ANDROID_SDK_ROOT/ANDROID_HOME is not set. Please install the Android SDK and expose the path."
fi

if [ ! -d "$ANDROID_SDK_ROOT" ]; then
  fail "Android SDK directory '$ANDROID_SDK_ROOT' does not exist."
fi

info "Using project root: $PROJECT_ROOT"
info "Using Android SDK root: $ANDROID_SDK_ROOT"

export GRADLE_USER_HOME="${GRADLE_USER_HOME:-$PROJECT_ROOT/.gradle-cache}"
mkdir -p "$GRADLE_USER_HOME"
info "Using Gradle user home: $GRADLE_USER_HOME"

if ! npm exec -- tauri -V >/dev/null 2>&1; then
  fail "Tauri CLI not found. Install it with 'npm install --save-dev @tauri-apps/cli'."
fi

if [ ! -d node_modules ]; then
  info "Installing npm dependencies (node_modules missing)..."
  npm ci
fi

info "Building web assets..."
npm run build

info "Building Android APK via Tauri (release profile)..."

# Clean up stale tauri plugin cache directories to avoid "File exists" conflicts
CARGO_HOME="${CARGO_HOME:-$HOME/.cargo}"
TAURI_CACHE_ROOT="$CARGO_HOME/registry/src"
if [ -d "$TAURI_CACHE_ROOT" ]; then
  info "Clearing cached Tauri plugin sources..."
  find "$TAURI_CACHE_ROOT" -maxdepth 2 -type d \( -name 'tauri-plugin-fs-*' -o -name 'tauri-plugin-opener-*' \) -prune -exec rm -rf {} + 2>/dev/null || true
fi

npm exec -- tauri android build "$@"

# Signing section -----------------------------------------------------------

UNSIGNED_APK="src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release-unsigned.apk"
[ -f "$UNSIGNED_APK" ] || fail "Unsigned APK not found at $UNSIGNED_APK"

KEYSTORE_PATH="${ANDROID_KEYSTORE_PATH:-$HOME/.android/release.keystore}"
KEY_ALIAS="${ANDROID_KEY_ALIAS:-release}"
KEYSTORE_PASSWORD="${ANDROID_KEYSTORE_PASSWORD:-}"
KEY_PASSWORD="${ANDROID_KEY_PASSWORD:-$KEYSTORE_PASSWORD}"
USING_RELEASE_KEYSTORE=false
STRICT_RELEASE=false

if [ "${RELEASE_STRICT:-0}" = "1" ] \
  || { [ "${CI:-false}" = "true" ] && [ "${RELEASE_JOB:-false}" = "true" ]; }; then
  STRICT_RELEASE=true
fi

handle_release_keystore_failure() {
  local reason="$1"
  if [ "$STRICT_RELEASE" = true ]; then
    fail "$reason Debug keystore fallback is disabled for release builds."
  fi
  warn "$reason Falling back to debug keystore."
}

check_keystore_entry() {
  local keystore="$1"
  local alias="$2"
  local storepass="$3"
  local keypass="$4"

  local output
  if ! output=$(keytool -list -v -keystore "$keystore" -storepass "$storepass" -alias "$alias" -keypass "$keypass" 2>&1); then
    warn "Failed to inspect keystore '$keystore' alias '$alias': $output"
    return 1
  fi

  if echo "$output" | grep -qi "PrivateKeyEntry"; then
    return 0
  fi

  warn "Keystore alias '$alias' in '$keystore' is not a PrivateKeyEntry"
  return 1
}

if [ -f "$KEYSTORE_PATH" ] && [ -n "$KEYSTORE_PASSWORD" ] && [ -n "$KEY_PASSWORD" ]; then
  if check_keystore_entry "$KEYSTORE_PATH" "$KEY_ALIAS" "$KEYSTORE_PASSWORD" "$KEY_PASSWORD"; then
    info "Using release keystore: $KEYSTORE_PATH (alias $KEY_ALIAS)"
    USING_RELEASE_KEYSTORE=true
  else
    handle_release_keystore_failure "Release keystore '$KEYSTORE_PATH' alias '$KEY_ALIAS' is invalid."
  fi
else
  if [ ! -f "$KEYSTORE_PATH" ]; then
    handle_release_keystore_failure "Release keystore '$KEYSTORE_PATH' not found."
  else
    handle_release_keystore_failure "Release keystore passwords not provided."
  fi
fi

if [ "$USING_RELEASE_KEYSTORE" = false ]; then
  DEBUG_KEYSTORE="${ANDROID_DEBUG_KEYSTORE_PATH:-$HOME/.android/debug.keystore}"
  DEBUG_ALIAS="${ANDROID_DEBUG_KEY_ALIAS:-androiddebugkey}"
  DEBUG_PASS="${ANDROID_DEBUG_KEYSTORE_PASSWORD:-android}"
  DEBUG_KEY_PASS="${ANDROID_DEBUG_KEY_PASSWORD:-$DEBUG_PASS}"

  regenerate_debug_keystore() {
    info "Generating Android debug keystore at $DEBUG_KEYSTORE"
    mkdir -p "$(dirname "$DEBUG_KEYSTORE")"
    rm -f "$DEBUG_KEYSTORE"
    keytool -genkeypair \
      -keystore "$DEBUG_KEYSTORE" \
      -storepass "$DEBUG_PASS" \
      -keypass "$DEBUG_KEY_PASS" \
      -alias "$DEBUG_ALIAS" \
      -keyalg RSA \
      -keysize 2048 \
      -validity 10000 \
      -dname "CN=Android Debug,O=Android,C=US" >/dev/null 2>&1
  }

  if [ ! -f "$DEBUG_KEYSTORE" ] || ! check_keystore_entry "$DEBUG_KEYSTORE" "$DEBUG_ALIAS" "$DEBUG_PASS" "$DEBUG_KEY_PASS"; then
    regenerate_debug_keystore || fail "Failed to create debug keystore automatically."
  fi

  if check_keystore_entry "$DEBUG_KEYSTORE" "$DEBUG_ALIAS" "$DEBUG_PASS" "$DEBUG_KEY_PASS"; then
    info "Falling back to Android debug keystore: $DEBUG_KEYSTORE (alias $DEBUG_ALIAS)"
    KEYSTORE_PATH="$DEBUG_KEYSTORE"
    KEY_ALIAS="$DEBUG_ALIAS"
    KEYSTORE_PASSWORD="$DEBUG_PASS"
    KEY_PASSWORD="$DEBUG_KEY_PASS"
  else
    fail "Keystore alias '$KEY_ALIAS' is invalid and debug keystore could not be prepared."
  fi
fi

find_build_tool() {
  local tool="$1"
  if command -v "$tool" >/dev/null 2>&1; then
    command -v "$tool"
    return 0
  fi
  local sdk="${ANDROID_SDK_ROOT}"
  if [ -z "$sdk" ]; then
    return 1
  fi
  local dirs
  IFS=$'\n' read -rd '' -a dirs < <(find "$sdk"/build-tools -maxdepth 1 -mindepth 1 -type d 2>/dev/null | sort -V && printf '\0')
  for dir in "${dirs[@]}"; do
    if [ -x "$dir/$tool" ]; then
      echo "$dir/$tool"
      return 0
    fi
  done
  return 1
}

ZIPALIGN=$(find_build_tool zipalign)
APKSIGNER=$(find_build_tool apksigner)
[ -n "$ZIPALIGN" ] || fail "zipalign not found in \$ANDROID_HOME/build-tools. Please install it."
[ -n "$APKSIGNER" ] || fail "apksigner not found in \$ANDROID_HOME/build-tools. Please install it."

OUTPUT_DIR="$(dirname "$UNSIGNED_APK")"
ALIGNED_APK="$OUTPUT_DIR/app-universal-release-aligned.apk"
SIGNED_APK="$OUTPUT_DIR/app-universal-release-signed.apk"

rm -f "$ALIGNED_APK" "$SIGNED_APK"

info "Aligning APK..."
"$ZIPALIGN" -v 4 "$UNSIGNED_APK" "$ALIGNED_APK" || fail "zipalign failed"

info "Signing APK..."
"$APKSIGNER" sign \
  --ks "$KEYSTORE_PATH" \
  --ks-key-alias "$KEY_ALIAS" \
  --ks-pass "pass:$KEYSTORE_PASSWORD" \
  --key-pass "pass:$KEY_PASSWORD" \
  --in "$ALIGNED_APK" \
  --out "$SIGNED_APK" || fail "apksigner failed"

info "Verifying signature..."
"$APKSIGNER" verify --print-certs "$SIGNED_APK" || fail "Signature verification failed"

info "APK build finished. Signed APK: $SIGNED_APK"
