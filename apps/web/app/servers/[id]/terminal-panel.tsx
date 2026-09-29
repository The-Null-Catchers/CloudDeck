'use client';
import {useCallback,useEffect,useRef,useState} from 'react';
import {TerminalSquare,Play,Square,ShieldCheck,Wifi,WifiOff} from 'lucide-react';
import {Terminal} from '@xterm/xterm';
import {FitAddon} from '@xterm/addon-fit';
import {openTerminalSession,type TerminalStreamEvent} from '@/lib/api';

type Status='idle'|'connecting'|'live'|'closed'|'error';

function decodeBase64(value:string,decoder:TextDecoder){
  const raw=atob(value);
  const bytes=new Uint8Array(raw.length);
  for(let i=0;i<raw.length;i++)bytes[i]=raw.charCodeAt(i);
  return decoder.decode(bytes,{stream:true});
}

export function TerminalPanel({serverId,demo,online}:{serverId:string;demo:boolean;online:boolean}){
  const hostRef=useRef<HTMLDivElement|null>(null);
  const terminalRef=useRef<Terminal|null>(null);
  const fitRef=useRef<FitAddon|null>(null);
  const socketRef=useRef<WebSocket|null>(null);
  const resizeRef=useRef<ResizeObserver|null>(null);
  const decoderRef=useRef(new TextDecoder());
  const [status,setStatus]=useState<Status>('idle');
  const [message,setMessage]=useState(demo?'Demo mode uses a local read-only terminal preview.':'Terminal contents are never stored by CloudDeck.');

  const sendResize=useCallback(()=>{
    const terminal=terminalRef.current;
    const fit=fitRef.current;
    const socket=socketRef.current;
    if(!terminal||!fit)return;
    try{fit.fit();}catch{return;}
    if(socket?.readyState===WebSocket.OPEN&&status==='live'){
      socket.send(JSON.stringify({type:'resize',cols:terminal.cols,rows:terminal.rows}));
    }
  },[status]);

  useEffect(()=>{
    const host=hostRef.current;
    if(!host)return;
    const terminal=new Terminal({
      cursorBlink:!demo,
      disableStdin:demo,
      convertEol:true,
      fontFamily:'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
      fontSize:13,
      lineHeight:1.25,
      scrollback:5000,
      theme:{background:'#0b1220',foreground:'#dbe6f5',cursor:'#7c9cff',selectionBackground:'#29416c'}
    });
    const fit=new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(host);
    terminalRef.current=terminal;
    fitRef.current=fit;
    if(demo){
      terminal.writeln('\x1b[1;36mCloudDeck demo terminal\x1b[0m');
      terminal.writeln('Read-only simulation — no server shell is opened.');
      terminal.write('\r\nclouddeck@demo:~$ ');
    }else{
      terminal.writeln('\x1b[90mTerminal idle. Start a session when you need shell access.\x1b[0m');
    }
    requestAnimationFrame(()=>{try{fit.fit();}catch{return;}});
    const observer=new ResizeObserver(()=>sendResize());
    observer.observe(host);
    resizeRef.current=observer;
    const input=terminal.onData(data=>{
      const socket=socketRef.current;
      if(socket?.readyState===WebSocket.OPEN&&status==='live')socket.send(JSON.stringify({type:'input',data}));
    });
    return()=>{
      input.dispose();
      observer.disconnect();
      const socket=socketRef.current;
      if(socket?.readyState===WebSocket.OPEN){
        socket.send(JSON.stringify({type:'close'}));
        socket.close(1000,'Page closed');
      }
      socketRef.current=null;
      terminal.dispose();
      terminalRef.current=null;
      fitRef.current=null;
    };
  },[demo,sendResize,status]);

  const stop=useCallback(()=>{
    const socket=socketRef.current;
    if(socket?.readyState===WebSocket.OPEN)socket.send(JSON.stringify({type:'close'}));
    socket?.close(1000,'User closed terminal');
    socketRef.current=null;
    setStatus('closed');
    setMessage('Terminal session closed.');
    terminalRef.current?.writeln('\r\n\x1b[90m[session closed]\x1b[0m');
  },[]);

  const start=useCallback(async()=>{
    if(demo){
      setStatus('closed');
      setMessage('Demo terminal is intentionally read-only.');
      return;
    }
    if(!online){
      setStatus('error');
      setMessage('Server agent is offline. Terminal access requires an active agent connection.');
      return;
    }
    if(socketRef.current?.readyState===WebSocket.OPEN)return;
    setStatus('connecting');
    setMessage('Creating an audited terminal session…');
    const terminal=terminalRef.current;
    terminal?.clear();
    terminal?.writeln('\x1b[90mConnecting to server agent…\x1b[0m');
    try{
      const socket=await openTerminalSession(serverId,(event:TerminalStreamEvent)=>{
        if(event.type==='ready'){
          setStatus('live');
          setMessage('Live session · 30 minute maximum · contents are not recorded');
          terminal?.clear();
          requestAnimationFrame(()=>sendResize());
          return;
        }
        if(event.type==='data'&&event.data){
          try{terminal?.write(decodeBase64(event.data,decoderRef.current));}
          catch{terminal?.writeln('\r\n\x1b[31m[invalid terminal output]\x1b[0m');}
          return;
        }
        if(event.type==='exit'){
          const suffix=event.error?': '+event.error:event.exitCode!==undefined?' (exit '+event.exitCode+')':'';
          terminal?.writeln('\r\n\x1b[90m[session ended'+suffix+']\x1b[0m');
          setStatus(event.error?'error':'closed');
          setMessage(event.error??'Terminal process exited.');
          socketRef.current=null;
        }
      });
      socketRef.current=socket;
      socket.onerror=()=>{
        setStatus('error');
        setMessage('Terminal WebSocket connection failed.');
      };
      socket.onclose=()=>{
        if(socketRef.current===socket)socketRef.current=null;
        setStatus(current=>current==='error'?current:'closed');
      };
    }catch(error){
      setStatus('error');
      setMessage(error instanceof Error?error.message:'Unable to start terminal session');
      terminal?.writeln('\r\n\x1b[31m[terminal unavailable]\x1b[0m');
    }
  },[demo,online,sendResize,serverId]);

  return <section className="chart-card terminal-panel">
    <div className="terminal-heading">
      <div>
        <h2><TerminalSquare size={18}/> Browser terminal</h2>
        <p>Browser → API → outbound agent → local PTY</p>
      </div>
      <div className="terminal-actions">
        <span className={'terminal-status '+status}>{status==='live'?<Wifi size={12}/>:<WifiOff size={12}/>} {status}</span>
        {status==='live'||status==='connecting'
          ?<button className="terminal-stop" onClick={stop}><Square size={13}/> Close session</button>
          :<button className="primary" onClick={start} disabled={demo||!online}><Play size={13}/> Open terminal</button>}
      </div>
    </div>
    <div className="terminal-security"><ShieldCheck size={14}/><span>{message}</span></div>
    <div className="terminal-host" ref={hostRef} aria-label="CloudDeck browser terminal"/>
  </section>;
}
