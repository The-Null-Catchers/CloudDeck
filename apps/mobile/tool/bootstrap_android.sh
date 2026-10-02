#!/usr/bin/env sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"

if ! command -v flutter >/dev/null 2>&1; then
  echo "Flutter is required to generate the Android runner." >&2
  exit 1
fi

if [ ! -d android ]; then
  flutter create \
    --platforms=android \
    --org org.clouddeck \
    --project-name clouddeck_mobile \
    --no-pub \
    .
fi

mkdir -p android/app/src/main android/app/src/debug

if [ -f android/app/build.gradle.kts ]; then
  sed -i 's/org\.clouddeck\.clouddeck_mobile/org.clouddeck.mobile/g' android/app/build.gradle.kts
fi
rm -rf android/app/src/main/kotlin
mkdir -p android/app/src/main/kotlin/org/clouddeck/mobile
cat > android/app/src/main/kotlin/org/clouddeck/mobile/MainActivity.kt <<'EOF'
package org.clouddeck.mobile

import io.flutter.embedding.android.FlutterActivity

class MainActivity : FlutterActivity()
EOF

cat > android/app/src/main/AndroidManifest.xml <<'EOF'
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <uses-permission android:name="android.permission.INTERNET" />

    <application
        android:label="CloudDeck"
        android:name="${applicationName}"
        android:icon="@mipmap/ic_launcher"
        android:usesCleartextTraffic="false">
        <activity
            android:name=".MainActivity"
            android:exported="true"
            android:launchMode="singleTop"
            android:taskAffinity=""
            android:theme="@style/LaunchTheme"
            android:configChanges="orientation|keyboardHidden|keyboard|screenSize|smallestScreenSize|locale|layoutDirection|fontScale|screenLayout|density|uiMode"
            android:hardwareAccelerated="true"
            android:windowSoftInputMode="adjustResize">
            <meta-data
              android:name="io.flutter.embedding.android.NormalTheme"
              android:resource="@style/NormalTheme" />
            <intent-filter>
                <action android:name="android.intent.action.MAIN"/>
                <category android:name="android.intent.category.LAUNCHER"/>
            </intent-filter>
        </activity>
        <meta-data
            android:name="flutterEmbedding"
            android:value="2" />
    </application>
</manifest>
EOF

cat > android/app/src/debug/AndroidManifest.xml <<'EOF'
<manifest xmlns:android="http://schemas.android.com/apk/res/android"
    xmlns:tools="http://schemas.android.com/tools">
    <uses-permission android:name="android.permission.INTERNET"/>
    <application
        android:usesCleartextTraffic="true"
        tools:replace="android:usesCleartextTraffic"/>
</manifest>
EOF

printf '%s\n' "Android runner ready at $ROOT/android"
