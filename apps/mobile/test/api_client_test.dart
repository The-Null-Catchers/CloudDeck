import 'dart:convert';

import 'package:clouddeck_mobile/core/api_client.dart';
import 'package:clouddeck_mobile/core/session_store.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

final class MemorySessionStore implements SessionStore {
  String? token;
  @override Future<void> clear() async => token=null;
  @override Future<String?> readRefreshToken() async => token;
  @override Future<void> writeRefreshToken(String value) async => token=value;
}

void main(){
  test('API client rotates native refresh token after an access-token 401',() async {
    final store=MemorySessionStore();
    var protectedCalls=0;
    final client=MockClient((request) async {
      if(request.url.path=='/api/v1/auth/mobile/login'){
        return http.Response(jsonEncode({'accessToken':'access-1','refreshToken':'refresh-1','expiresIn':600}),200,headers:{'content-type':'application/json'});
      }
      if(request.url.path=='/api/v1/auth/mobile/refresh'){
        final body=jsonDecode(request.body) as Map<String,dynamic>;
        expect(body['refreshToken'],'refresh-1');
        return http.Response(jsonEncode({'accessToken':'access-2','refreshToken':'refresh-2','expiresIn':600}),200,headers:{'content-type':'application/json'});
      }
      if(request.url.path=='/protected'){
        protectedCalls++;
        if(request.headers['authorization']=='Bearer access-1'){
          return http.Response(jsonEncode({'error':{'message':'expired'}}),401,headers:{'content-type':'application/json'});
        }
        expect(request.headers['authorization'],'Bearer access-2');
        return http.Response(jsonEncode({'ok':true}),200,headers:{'content-type':'application/json'});
      }
      return http.Response('not found',404);
    });
    final api=ApiClient(sessionStore:store,client:client,baseUrl:'https://clouddeck.test');
    await api.login(email:'user@example.com',password:'secure passphrase 2026',deviceName:'test');
    expect(store.token,'refresh-1');
    final result=await api.get('/protected') as Map<String,dynamic>;
    expect(result['ok'],true);
    expect(store.token,'refresh-2');
    expect(protectedCalls,2);
    api.close();
  });

  test('restore session clears an expired refresh token',() async {
    final store=MemorySessionStore()..token='expired-refresh';
    final api=ApiClient(
      sessionStore:store,
      client:MockClient((request) async=>http.Response(
        jsonEncode({'error':{'message':'Session expired'}}),
        401,
        headers:{'content-type':'application/json'},
      )),
      baseUrl:'https://clouddeck.test',
    );
    expect(await api.restoreSession(),false);
    expect(store.token,isNull);
    api.close();
  });
}
