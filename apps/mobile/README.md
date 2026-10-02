# CloudDeck Mobile

Flutter client for monitoring and emergency operations.

## Implemented

- native sign-in using rotating bearer refresh tokens
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

Platform-specific Android/iOS runner projects and release signing are added in the next release slice. Never embed production API secrets or refresh tokens in build-time configuration.
