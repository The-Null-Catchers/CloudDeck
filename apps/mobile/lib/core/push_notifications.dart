import 'dart:async';
import 'dart:io';

import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import 'api_client.dart';

final class CloudDeckFirebaseOptions {
  static const _projectId = String.fromEnvironment('CLOUDDECK_FIREBASE_PROJECT_ID');
  static const _senderId = String.fromEnvironment('CLOUDDECK_FIREBASE_MESSAGING_SENDER_ID');
  static const _androidAppId = String.fromEnvironment('CLOUDDECK_FIREBASE_ANDROID_APP_ID');
  static const _androidApiKey = String.fromEnvironment('CLOUDDECK_FIREBASE_ANDROID_API_KEY');
  static const _iosAppId = String.fromEnvironment('CLOUDDECK_FIREBASE_IOS_APP_ID');
  static const _iosApiKey = String.fromEnvironment('CLOUDDECK_FIREBASE_IOS_API_KEY');

  static bool get configured {
    if (_projectId.isEmpty || _senderId.isEmpty) return false;
    if (Platform.isAndroid) return _androidAppId.isNotEmpty && _androidApiKey.isNotEmpty;
    if (Platform.isIOS) return _iosAppId.isNotEmpty && _iosApiKey.isNotEmpty;
    return false;
  }

  static FirebaseOptions get current {
    if (!configured) throw StateError('Firebase is not configured for this platform');
    if (Platform.isAndroid) {
      return const FirebaseOptions(
        apiKey: _androidApiKey,
        appId: _androidAppId,
        messagingSenderId: _senderId,
        projectId: _projectId,
      );
    }
    if (Platform.isIOS) {
      return const FirebaseOptions(
        apiKey: _iosApiKey,
        appId: _iosAppId,
        messagingSenderId: _senderId,
        projectId: _projectId,
        iosBundleId: 'org.clouddeck.mobile',
      );
    }
    throw UnsupportedError('Push notifications are supported only on Android and iOS');
  }
}

@pragma('vm:entry-point')
Future<void> cloudDeckFirebaseBackgroundHandler(RemoteMessage message) async {
  if (!CloudDeckFirebaseOptions.configured) return;
  try {
    if (Firebase.apps.isEmpty) {
      await Firebase.initializeApp(options: CloudDeckFirebaseOptions.current);
    }
  } catch (_) {
    // Delivery is still displayed by the OS when the message contains notification data.
  }
}

final class PushNavigationIntent {
  const PushNavigationIntent({required this.type, this.href});
  final String type;
  final String? href;

  factory PushNavigationIntent.fromData(Map<String, dynamic> data) {
    final rawType = data['type'];
    final rawHref = data['href'];
    return PushNavigationIntent(
      type: rawType is String && rawType.isNotEmpty ? rawType : 'info',
      href: rawHref is String && rawHref.isNotEmpty ? rawHref : null,
    );
  }

  factory PushNavigationIntent.fromMessage(RemoteMessage message) =>
      PushNavigationIntent.fromData(message.data);
}

final class PushNotificationService {
  PushNotificationService({
    required this.api,
    FlutterSecureStorage? storage,
  }) : _storage = storage ?? const FlutterSecureStorage();

  static const _deviceIdKey = 'clouddeck_push_device_id';

  final ApiClient api;
  final FlutterSecureStorage _storage;
  final StreamController<void> _activity = StreamController<void>.broadcast();
  final StreamController<PushNavigationIntent> _navigation =
      StreamController<PushNavigationIntent>.broadcast();
  StreamSubscription<String>? _tokenSubscription;
  StreamSubscription<RemoteMessage>? _foregroundSubscription;
  StreamSubscription<RemoteMessage>? _openedSubscription;
  FirebaseMessaging? _messaging;
  PushNavigationIntent? _pendingNavigation;
  bool _initialized = false;
  bool _signedIn = false;

  Stream<void> get activity => _activity.stream;
  Stream<PushNavigationIntent> get navigation => _navigation.stream;
  bool get available => CloudDeckFirebaseOptions.configured;

  PushNavigationIntent? takePendingNavigation() {
    final value = _pendingNavigation;
    _pendingNavigation = null;
    return value;
  }

  Future<bool> configureForSignedInUser() async {
    _signedIn = true;
    if (!available) return false;
    try {
      await _initialize();
      final messaging = _messaging!;
      final settings = await messaging.requestPermission(
        alert: true,
        badge: true,
        sound: true,
        provisional: false,
      );
      if (settings.authorizationStatus == AuthorizationStatus.denied) return false;
      final token = await messaging.getToken();
      if (token == null || token.isEmpty) return false;
      await _registerToken(token);
      return true;
    } catch (_) {
      return false;
    }
  }

  Future<void> unregisterCurrentDevice() async {
    _signedIn = false;
    _pendingNavigation = null;
    final deviceId = await _storage.read(key: _deviceIdKey);
    if (deviceId == null || deviceId.isEmpty) return;
    try {
      await api.delete('/api/v1/push-devices/$deviceId');
      await _storage.delete(key: _deviceIdKey);
    } on ApiException catch (error) {
      if (error.statusCode == 404 || error.statusCode == 401) {
        await _storage.delete(key: _deviceIdKey);
        return;
      }
      try {
        await _messaging?.deleteToken();
      } finally {
        await _storage.delete(key: _deviceIdKey);
      }
    }
  }

  Future<void> _initialize() async {
    if (_initialized) return;
    if (Firebase.apps.isEmpty) {
      await Firebase.initializeApp(options: CloudDeckFirebaseOptions.current);
    }
    final messaging = FirebaseMessaging.instance;
    _messaging = messaging;
    _tokenSubscription = messaging.onTokenRefresh.listen((token) async {
      if (!_signedIn || token.isEmpty) return;
      try {
        await _registerToken(token);
      } catch (_) {
        // The next app resume/login or token refresh retries registration.
      }
    });
    _foregroundSubscription = FirebaseMessaging.onMessage.listen((_) => _activity.add(null));
    _openedSubscription = FirebaseMessaging.onMessageOpenedApp.listen(_handleOpenedMessage);
    final initialMessage = await messaging.getInitialMessage();
    if (initialMessage != null) _handleOpenedMessage(initialMessage);
    _initialized = true;
  }

  void _handleOpenedMessage(RemoteMessage message) {
    final intent = PushNavigationIntent.fromMessage(message);
    _activity.add(null);
    _pendingNavigation = intent;
    if (_navigation.hasListener) {
      _pendingNavigation = null;
      _navigation.add(intent);
    }
  }

  Future<void> _registerToken(String token) async {
    final platform = Platform.isIOS ? 'ios' : 'android';
    final payload = await api.put(
      '/api/v1/push-devices',
      body: {
        'provider': 'fcm',
        'platform': platform,
        'token': token,
        'deviceName': '$platform CloudDeck',
      },
    );
    final device = payload is Map<String, dynamic> ? payload['device'] : null;
    final id = device is Map<String, dynamic> ? device['id'] : null;
    if (id is String && id.isNotEmpty) {
      await _storage.write(key: _deviceIdKey, value: id);
    }
  }

  Future<void> dispose() async {
    _signedIn = false;
    _pendingNavigation = null;
    await _tokenSubscription?.cancel();
    await _foregroundSubscription?.cancel();
    await _openedSubscription?.cancel();
    await _activity.close();
    await _navigation.close();
  }
}
