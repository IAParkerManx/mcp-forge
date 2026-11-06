#!/bin/sh
# Builds build/pocketnotes.apk with the Android SDK tools directly (no Gradle).
# Needs JAVA_HOME (JDK 17+) and ANDROID_HOME (platforms;android-35, build-tools;35.0.1).
set -eu
cd "$(dirname "$0")"
: "${ANDROID_HOME:?set ANDROID_HOME to the Android SDK}"
BT="$ANDROID_HOME/build-tools/35.0.1"
JAR="$ANDROID_HOME/platforms/android-35/android.jar"
rm -rf build && mkdir -p build/classes build/dex
"$JAVA_HOME/bin/javac" --release 11 -nowarn -cp "$JAR" -d build/classes src/com/example/pocketnotes/*.java
"$BT/d8" --release --min-api 26 --lib "$JAR" --output build/dex $(find build/classes -name '*.class')
"$BT/aapt2" link -o build/unsigned.apk --manifest AndroidManifest.xml -I "$JAR" \
  --min-sdk-version 26 --target-sdk-version 35 --version-code 1 --version-name 1.0
(cd build/dex && zip -q ../unsigned.apk classes.dex)
"$BT/zipalign" -f 4 build/unsigned.apk build/aligned.apk
# Throwaway debug key, generated per build; never use it for anything real.
"$JAVA_HOME/bin/keytool" -genkeypair -keystore build/debug.keystore -storepass android -keypass android \
  -alias debug -keyalg RSA -keysize 2048 -validity 3650 -dname "CN=mcp-forge demo" >/dev/null 2>&1
"$BT/apksigner" sign --ks build/debug.keystore --ks-pass pass:android --out build/pocketnotes.apk build/aligned.apk
echo "built build/pocketnotes.apk"
