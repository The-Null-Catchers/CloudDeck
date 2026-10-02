package main

import (
 "encoding/json"
 "net"
 "net/http"
 "os"
 "path/filepath"
 "testing"
)

func TestProxyAgentBridgeUsesUnixSocketAndTypedPayload(t *testing.T){
 socket:=filepath.Join(t.TempDir(),"helper.sock")
 listener,err:=net.Listen("unix",socket);if err!=nil{t.Fatal(err)}
 defer listener.Close()
 received:=make(chan proxyCommandPayload,1)
 mux:=http.NewServeMux()
 mux.HandleFunc("/v1/apply",func(w http.ResponseWriter,r *http.Request){
  var payload proxyCommandPayload
  if err:=json.NewDecoder(r.Body).Decode(&payload);err!=nil{t.Error(err);w.WriteHeader(400);return}
  received<-payload
  w.Header().Set("Content-Type","application/json")
  _,_=w.Write([]byte(`{"ok":true}`))
 })
 server:=&http.Server{Handler:mux};go server.Serve(listener);defer server.Close()
 t.Setenv("CLOUDDECK_PROXY_HELPER_SOCKET",socket)

 command:=agentCommand{
  Type:"command",RequestID:"proxy-1",Action:"proxy.applyDomain",
  Payload:json.RawMessage(`{"proxyType":"caddy","hostname":"api.example.com","targetPort":4000}`),
 }
 result:=executeProxyCommand(t.Context(),command)
 if !result.Success{t.Fatalf("proxy command failed: %s",result.Error)}
 payload:=<-received
 if payload.Hostname!="api.example.com"||payload.ProxyType!="caddy"||payload.TargetPort!=4000{t.Fatalf("unexpected helper payload: %+v",payload)}
}

func TestProxyAgentBridgeRejectsUnexpectedOrUnsafeInput(t *testing.T){
 t.Setenv("CLOUDDECK_PROXY_HELPER_SOCKET",filepath.Join(t.TempDir(),"missing.sock"))
 cases:=[]agentCommand{
  {Type:"command",RequestID:"1",Action:"proxy.applyDomain",Payload:json.RawMessage(`{"proxyType":"caddy","hostname":"../bad","targetPort":4000}`)},
  {Type:"command",RequestID:"2",Action:"proxy.applyDomain",Payload:json.RawMessage(`{"proxyType":"caddy","hostname":"api.example.com","targetPort":4000,"command":"rm -rf /"}`)},
  {Type:"command",RequestID:"3",Action:"proxy.removeDomain",Payload:json.RawMessage(`{"proxyType":"nginx","hostname":"api.example.com","targetPort":80}`)},
 }
 for _,command:=range cases{
  result:=executeProxyCommand(t.Context(),command)
  if result.Success{t.Fatalf("unsafe proxy payload accepted: %s",string(command.Payload))}
 }
}

func TestProxyHelperSocketMustBeAbsolute(t *testing.T){
 old,had:=os.LookupEnv("CLOUDDECK_PROXY_HELPER_SOCKET")
 t.Setenv("CLOUDDECK_PROXY_HELPER_SOCKET","relative.sock")
 _,_,err:=proxyHelperClient()
 if err==nil{t.Fatal("expected relative helper socket to be rejected")}
 if had{_ = os.Setenv("CLOUDDECK_PROXY_HELPER_SOCKET",old)}
}
