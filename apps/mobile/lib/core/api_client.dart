import 'dart:convert';
import 'dart:io';

import 'package:http/http.dart' as http;

import 'session_store.dart';

final class ApiException implements Exception {
  ApiException(this.message, {this.statusCode});
  final String message;
  final int? statusCode;

  @override
  String toString() => message;
}

final class ApiClient {
  ApiClient({
    required this.sessionStore,
    http.Client? client,
    String? baseUrl,
  })  : _client = client ?? http.Client(),
        baseUrl = (baseUrl ??
                const String.fromEnvironment(
                  'CLOUDDECK_API_URL',
                  defaultValue: 'http://10.0.2.2:4000',
                ))
            .replaceFirst(RegExp(r'/+$'), '');

  final SessionStore sessionStore;
  final http.Client _client;
  final String baseUrl;
  String? _accessToken;
  Future<bool>? _refreshInFlight;

  bool get authenticated => _accessToken != null;

  Future<Map<String, dynamic>> login({
    required String email,
    required String password,
    required String deviceName,
  }) async {
    final response = await _raw(
      'POST',
      '/api/v1/auth/mobile/login',
      body: {
        'email': email.trim().toLowerCase(),
        'password': password,
        'deviceName': deviceName,
      },
    );
    _acceptSession(response);
    return response;
  }

  Future<bool> restoreSession() async {
    final token = await sessionStore.readRefreshToken();
    if (token == null || token.isEmpty) return false;
    return _refresh();
  }

  Future<void> logout() async {
    final refresh = await sessionStore.readRefreshToken();
    try {
      if (refresh != null) {
        await _raw(
          'POST',
          '/api/v1/auth/mobile/logout',
          body: {'refreshToken': refresh},
        );
      }
    } finally {
      _accessToken = null;
      await sessionStore.clear();
    }
  }

  Future<dynamic> get(String path) => _authorized('GET', path);
  Future<dynamic> post(String path, {Object? body}) =>
      _authorized('POST', path, body: body);

  Future<dynamic> _authorized(
    String method,
    String path, {
    Object? body,
    bool retried = false,
  }) async {
    if (_accessToken == null && !await restoreSession()) {
      throw ApiException('Session expired', statusCode: 401);
    }
    final response = await _request(
      method,
      path,
      body: body,
      authorization: _accessToken,
    );
    if (response.statusCode == 401 && !retried && await _refresh()) {
      return _authorized(method, path, body: body, retried: true);
    }
    return _decode(response);
  }

  Future<bool> _refresh() {
    final running = _refreshInFlight;
    if (running != null) return running;
    final future = _performRefresh();
    _refreshInFlight = future;
    return future.whenComplete(() => _refreshInFlight = null);
  }

  Future<bool> _performRefresh() async {
    final refresh = await sessionStore.readRefreshToken();
    if (refresh == null || refresh.isEmpty) {
      _accessToken = null;
      return false;
    }
    try {
      final response = await _raw(
        'POST',
        '/api/v1/auth/mobile/refresh',
        body: {'refreshToken': refresh},
      );
      _acceptSession(response);
      return true;
    } on ApiException catch (error) {
      if (error.statusCode == 401) {
        _accessToken = null;
        await sessionStore.clear();
        return false;
      }
      rethrow;
    }
  }

  void _acceptSession(Map<String, dynamic> response) {
    final access = response['accessToken'];
    final refresh = response['refreshToken'];
    if (access is! String || refresh is! String) {
      throw ApiException('Invalid authentication response');
    }
    _accessToken = access;
    sessionStore.writeRefreshToken(refresh);
  }

  Future<Map<String, dynamic>> _raw(
    String method,
    String path, {
    Object? body,
  }) async {
    final response = await _request(method, path, body: body);
    final decoded = _decode(response);
    if (decoded is! Map<String, dynamic>) {
      throw ApiException('Invalid API response', statusCode: response.statusCode);
    }
    return decoded;
  }

  Future<http.Response> _request(
    String method,
    String path, {
    Object? body,
    String? authorization,
  }) async {
    final uri = Uri.parse('$baseUrl$path');
    final headers = <String, String>{
      HttpHeaders.acceptHeader: 'application/json',
      if (body != null) HttpHeaders.contentTypeHeader: 'application/json',
      if (authorization != null)
        HttpHeaders.authorizationHeader: 'Bearer $authorization',
    };
    try {
      return switch (method) {
        'GET' => await _client.get(uri, headers: headers),
        'POST' => await _client.post(
            uri,
            headers: headers,
            body: body == null ? null : jsonEncode(body),
          ),
        _ => throw ApiException('Unsupported mobile API method'),
      };
    } on SocketException {
      throw ApiException('Unable to reach CloudDeck');
    } on http.ClientException {
      throw ApiException('CloudDeck connection failed');
    }
  }

  dynamic _decode(http.Response response) {
    dynamic decoded;
    if (response.body.isNotEmpty) {
      try {
        decoded = jsonDecode(response.body);
      } on FormatException {
        throw ApiException(
          'CloudDeck returned an invalid response',
          statusCode: response.statusCode,
        );
      }
    }
    if (response.statusCode >= 200 && response.statusCode < 300) {
      return decoded;
    }
    final error = decoded is Map<String, dynamic> ? decoded['error'] : null;
    final message = error is Map<String, dynamic> && error['message'] is String
        ? error['message'] as String
        : 'CloudDeck request failed';
    throw ApiException(message, statusCode: response.statusCode);
  }

  void close() => _client.close();
}
