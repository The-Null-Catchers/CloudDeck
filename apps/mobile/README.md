# CloudDeck Mobile

Flutter client for monitoring and emergency operations.

## Implemented

- native sign-in using rotating bearer refresh tokens with TOTP/recovery-code challenge support
- refresh token persistence through `flutter_secure_storage` (Android Keystore / iOS Keychain-backed storage)
- workspace switching
- dashboard server/alert summaries
- server inventory
- 1h/6h/24h/7d metric history
- Docker container inventory
- bounded container log snapshots
- confirmed container restart for roles with operational permission
- open-alert acknowledgement
- deployment status/history
- notification center/read state
- optional Firebase Cloud Messaging registration on Android/iOS, token rotation handling, foreground refresh, notification-open navigation, and best-effort server deregistration on logout
- cold-start push intents buffered until the authenticated shell is ready
- light/dark theme

The mobile app intentionally does not expose browser terminal access in this phase. It focuses on monitoring and constrained emergency operations.

## Development

```bash
cd apps/mobile
flutter pub get
flutter analyze
flutter test
flutter run --dart-define=CLOUDDECK_API_URL=https://api.example.com
```

The default API URL is `http://10.0.2.2:4000` for Android emulator local development.

Native runner files are reproducibly generated with:

```bash
./tool/bootstrap_android.sh
./tool/bootstrap_ios.sh
```

Both platforms use the application identifier `org.clouddeck.mobile`. The generated Android release manifest disallows cleartext HTTP and declares Android 13+ `POST_NOTIFICATIONS`; runtime notification permission is requested only after a CloudDeck user is authenticated. Debug Android builds override cleartext only for local emulator/development use.

## Push notifications

Push support is disabled automatically when Firebase client configuration is absent. Release builds can inject the non-secret Firebase client identifiers with Dart defines instead of committing `google-services.json` or `GoogleService-Info.plist`:

```bash
flutter run \
  --dart-define=CLOUDDECK_API_URL=https://api.example.com \
  --dart-define=CLOUDDECK_FIREBASE_PROJECT_ID=your-project \
  --dart-define=CLOUDDECK_FIREBASE_MESSAGING_SENDER_ID=123456789 \
  --dart-define=CLOUDDECK_FIREBASE_ANDROID_APP_ID=1:123456789:android:example \
  --dart-define=CLOUDDECK_FIREBASE_ANDROID_API_KEY=example-public-client-key
```

For iOS use `CLOUDDECK_FIREBASE_IOS_APP_ID` and `CLOUDDECK_FIREBASE_IOS_API_KEY` instead of the Android-specific values. The Firebase project and messaging sender ID are shared.

The backend FCM service-account private key is separate from these client identifiers and must never be embedded in the app. iOS distribution also requires the App ID/provisioning profile to have the Push Notifications capability and Firebase/APNs credentials configured outside this repository.

On sign-in/session restore, the app asks for notification permission, obtains the FCM token, and registers it through the authenticated CloudDeck API. Token rotations are re-registered automatically. Logout attempts to remove the server-side device record before revoking the session; if that removal cannot be completed, the local FCM token is invalidated as a privacy fallback.

Opening a CloudDeck push uses only the bounded `type` and optional `href` emitted by the backend. Known server targets open the matching server detail screen; alert and deployment targets select their operational tab. Unknown targets fall back to the notification inbox rather than launching arbitrary external URLs. Cold-start notification intents are retained until the signed-in shell has subscribed, preventing notification taps from being lost during session restore.

CI builds a release-mode smoke APK on Linux and an unsigned release-mode iOS app on macOS against a non-routable HTTPS placeholder API. Firebase defines are intentionally omitted in CI, so push remains disabled while the native Firebase plugins still compile. The artifacts are short-lived validation outputs and are **not store-signed**. App Store/TestFlight signing credentials, provisioning profiles, and distribution certificates must stay in CI secret storage and are intentionally not committed to the repository.

Never embed production API secrets, refresh tokens, service-account credentials, or APNs private keys in build-time configuration.
