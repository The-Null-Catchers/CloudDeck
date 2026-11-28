import 'dart:async';
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
  test('request timeout surfaces a retryable error and preserves stored session',() async {
    final store=MemorySessionStore()..token='existing-refresh';
    final api=ApiClient(
      sessionStore:store,
      client:MockClient((_)=>Completer<http.Response>().future),
      baseUrl:'https://clouddeck.test',
      requestTimeout:const Duration(milliseconds:10),
    );
    await expectLater(api.restoreSession(),throwsA(isA<ApiException>().having((error)=>error.message,'message',contains('timed out'))));
    expect(store.token,'existing-refresh');
    api.close();
  });

  test('network interruption preserves refresh token for reconnection',() async {
    final store=MemorySessionStore()..token='existing-refresh';
    final api=ApiClient(
      sessionStore:store,
      client:MockClient((_)async=>throw http.ClientException('offline')),
      baseUrl:'https://clouddeck.test',
    );
    await expectLater(api.restoreSession(),throwsA(isA<ApiException>()));
    expect(store.token,'existing-refresh');
    api.close();
  });

  test('concurrent session recovery consumes the rotating refresh token once',() async {
    final store=MemorySessionStore()..token='refresh-1';
    final entered=Completer<void>();
    final response=Completer<http.Response>();
    var refreshes=0;
    final api=ApiClient(
      sessionStore:store,
      client:MockClient((request)async {
        if(request.url.path=='/api/v1/auth/mobile/refresh'){
          refreshes++;
          if(!entered.isCompleted)entered.complete();
          return response.future;
        }
        expect(request.headers['authorization'],'Bearer access-2');
        return http.Response('[]',200);
      }),
      baseUrl:'https://clouddeck.test',
    );
    final requests=Future.wait([api.get('/one'),api.get('/two')]);
    await entered.future;
    response.complete(http.Response(jsonEncode({'accessToken':'access-2','refreshToken':'refresh-2'}),200));
    expect(await requests,[[],[]]);
    expect(refreshes,1);
    expect(store.token,'refresh-2');
    api.close();
  });

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

  test('authorized PUT and DELETE use the active access token',() async {
    final store=MemorySessionStore();
    final methods=<String>[];
    final client=MockClient((request) async {
      if(request.url.path=='/api/v1/auth/mobile/login'){
        return http.Response(jsonEncode({'accessToken':'access-1','refreshToken':'refresh-1'}),200,headers:{'content-type':'application/json'});
      }
      expect(request.headers['authorization'],'Bearer access-1');
      methods.add(request.method);
      if(request.method=='PUT'){
        expect(jsonDecode(request.body),{'provider':'fcm'});
        return http.Response(jsonEncode({'device':{'id':'device-1'}}),200,headers:{'content-type':'application/json'});
      }
      if(request.method=='DELETE')return http.Response('',204);
      return http.Response('not found',404);
    });
    final api=ApiClient(sessionStore:store,client:client,baseUrl:'https://clouddeck.test');
    await api.login(email:'user@example.com',password:'secure passphrase 2026',deviceName:'test');
    final registered=await api.put('/api/v1/push-devices',body:{'provider':'fcm'}) as Map<String,dynamic>;
    expect((registered['device'] as Map<String,dynamic>)['id'],'device-1');
    expect(await api.delete('/api/v1/push-devices/device-1'),isNull);
    expect(methods,['PUT','DELETE']);
    api.close();
  });
}
