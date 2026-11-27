import assert from 'node:assert/strict';
import net from 'node:net';
import {once} from 'node:events';
import {test} from 'node:test';
import {sendChallenge,sendOperationalNotification,sendWorkspaceInvitation} from '../src/mail.js';

test('mail workflows deliver to a disposable loopback SMTP server', {timeout:15_000}, async t=>{
  const messages:string[]=[];
  const sockets=new Set<net.Socket>();
  const server=net.createServer(socket=>{
    sockets.add(socket);socket.on('close',()=>sockets.delete(socket));
    socket.setEncoding('utf8');
    socket.write('220 localhost CloudDeck test SMTP\r\n');
    let buffer='';let dataMode=false;let message='';
    socket.on('data',(chunk:string)=>{
      buffer+=chunk;
      if(buffer.length>100_000){socket.destroy();return;}
      let end:number;
      while((end=buffer.indexOf('\r\n'))>=0){
        const line=buffer.slice(0,end);buffer=buffer.slice(end+2);
        if(dataMode){
          if(line==='.') {messages.push(message);message='';dataMode=false;socket.write('250 queued\r\n');}
          else message+=line+'\n';
        }else if(line.startsWith('EHLO')||line.startsWith('HELO'))socket.write('250 localhost\r\n');
        else if(line==='DATA'){dataMode=true;socket.write('354 End with dot\r\n');}
        else if(line==='QUIT'){socket.end('221 Bye\r\n');}
        else if(/^(MAIL FROM:|RCPT TO:|RSET)/.test(line))socket.write('250 OK\r\n');
        else socket.write('500 unsupported\r\n');
      }
    });
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const envNames=['NODE_ENV','SMTP_HOST','SMTP_PORT','SMTP_SECURE','SMTP_USER','APP_ORIGIN'];
  const previous=new Map(envNames.map(name=>[name,process.env[name]]));
  t.after(async()=>{
    for(const [name,value]of previous){if(value===undefined)delete process.env[name];else process.env[name]=value;}
    for(const socket of sockets)socket.destroy();
    await new Promise<void>(resolve=>server.close(()=>resolve()));
  });
  process.env.NODE_ENV='development';
  process.env.SMTP_HOST='127.0.0.1';
  process.env.SMTP_PORT=String((server.address() as net.AddressInfo).port);
  process.env.SMTP_SECURE='false';delete process.env.SMTP_USER;
  process.env.APP_ORIGIN='https://clouddeck.example.invalid';
  await sendChallenge('verify_email','demo@example.invalid','synthetic-test-token');
  await sendWorkspaceInvitation('demo@example.invalid','Lab\r\nInjected: header','viewer','synthetic-test-invite');
  await sendOperationalNotification('demo@example.invalid','Test\r\nInjected: header','Synthetic message','//untrusted.invalid');
  assert.equal(messages.length,3);
  assert.match(messages[0],/verify\?token=synthetic-test-token/);
  assert.match(messages[1],/invite\?token=synthetic-test-invite/);
  assert.match(messages[2],/Subject: \[CloudDeck\] Test Injected: header/);
  assert.doesNotMatch(messages.join('\n'),/^Injected:/m);
  assert.doesNotMatch(messages[2],/untrusted\.invalid/);
});
