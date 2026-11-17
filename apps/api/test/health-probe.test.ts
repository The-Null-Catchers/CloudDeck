import {test} from 'node:test';
import assert from 'node:assert/strict';
import {promises as dns} from 'node:dns';
import {EventEmitter} from 'node:events';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import {isPublicHealthAddress,normalizeHealthTarget,probeHealthTarget} from '../src/health-probe.ts';

test('health probes reject private and reserved address ranges',()=>{
  for(const address of [
    '127.0.0.1','10.0.0.1','172.16.0.1','192.168.1.1','169.254.169.254',
    '100.64.0.1','192.0.2.1','198.51.100.1','203.0.113.1','224.0.0.1',
    '::1','fe80::1','fc00::1','2001:db8::1','::ffff:127.0.0.1'
  ]) assert.equal(isPublicHealthAddress(address),false,address);
  assert.equal(isPublicHealthAddress('1.1.1.1'),true);
  assert.equal(isPublicHealthAddress('2606:4700:4700::1111'),true);
});

for(const kind of ['http','https','tcp'] as const){
  test(`${kind} probes connect to public IPv6 literals without DNS`,async t=>{
    const address='2606:4700:4700::1111';
    t.mock.method(dns,'lookup',async()=>{throw new Error('IPv6 literals must not use DNS')});
    let connected=false;
    if(kind==='tcp'){
      t.mock.method(net,'createConnection',(options:net.NetConnectOpts)=>{
        assert.equal('host' in options&&options.host,address);
        assert.equal('port' in options&&options.port,8443);
        connected=true;
        const socket=new net.Socket();
        queueMicrotask(()=>socket.emit('connect'));
        return socket;
      });
    }else{
      t.mock.method(kind==='https'?https:http,'request',(
        options:http.RequestOptions,
        callback:(response:http.IncomingMessage)=>void
      )=>{
        assert.equal(options.host,address);
        assert.equal(options.port,8443);
        assert.equal(options.path,'/health?ready=1');
        assert.equal((options as https.RequestOptions).servername,undefined);
        assert.equal((options.headers as Record<string,string>).Host,`[${address}]:8443`);
        connected=true;
        const request=Object.assign(new EventEmitter(),{
          end(){queueMicrotask(()=>callback({statusCode:200,resume(){}} as http.IncomingMessage))},
          destroy(){}
        });
        return request as http.ClientRequest;
      });
    }
    const target=kind==='tcp'?`[${address}]:8443`:`${kind}://[${address}]:8443/health?ready=1`;
    const result=await probeHealthTarget(kind,target,5,null);
    assert.equal(result.success,true,result.error??'probe failed');
    assert.equal(connected,true);
    assert.equal(result.statusCode,kind==='tcp'?null:200);
  });

  test(`${kind} probes reject private IPv6 literals before DNS or transport`,async t=>{
    t.mock.method(dns,'lookup',async()=>{throw new Error('Unexpected DNS lookup')});
    t.mock.method(http,'request',()=>{throw new Error('Unexpected HTTP connection')});
    t.mock.method(https,'request',()=>{throw new Error('Unexpected HTTPS connection')});
    t.mock.method(net,'createConnection',()=>{throw new Error('Unexpected TCP connection')});
    for(const address of ['::1','fc00::1','fe80::1','::ffff:127.0.0.1','2001:db8::1']){
      const target=kind==='tcp'?`[${address}]:443`:`${kind}://[${address}]/health`;
      const result=await probeHealthTarget(kind,target,5,null);
      assert.equal(result.success,false);
      assert.match(result.error??'',/private or reserved addresses/);
    }
  });
}

test('health target normalization pins protocol and strips unsafe forms',()=>{
  assert.equal(normalizeHealthTarget('https','https://example.com/health'),'https://example.com/health');
  assert.equal(normalizeHealthTarget('tcp','example.com:443'),'example.com:443');
  assert.throws(()=>normalizeHealthTarget('https','http://example.com'));
  assert.throws(()=>normalizeHealthTarget('http','http://user:pass@example.com'));
  assert.throws(()=>normalizeHealthTarget('tcp','example.com'));
});
