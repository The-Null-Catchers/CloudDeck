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

Both platforms use the application identifier `org.clouddeck.mobile`. The generated Android release manifest disallows cleartext HTTP. Debug Android builds override cleartext only for local emulator/development use.

CI builds a release-mode smoke APK on Linux and an unsigned release-mode iOS app on macOS against a non-routable HTTPS placeholder API. The artifacts are short-lived validation outputs and are **not store-signed**. App Store/TestFlight signing credentials, provisioning profiles, and distribution certificates must stay in CI secret storage and are intentionally not committed to the repository.

Never embed production API secrets or refresh tokens in build-time configuration.
