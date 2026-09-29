package main

import (
 "encoding/json"
 "net"
 "net/http"
 "path/filepath"
 "testing"
)
func TestDockerAllowlistAndUnixSocket(t *testing.T) {
 socket:=filepath.Join(t.TempDir(),"docker.sock")
 listener,err:=net.Listen("unix",socket);if err!=nil{t.Fatal(err)}
 mux:=http.NewServeMux()
 calls:=0
 mux.HandleFunc("/containers/json",func(w http.ResponseWriter,r *http.Request){calls++;if r.Method!="GET" || r.URL.Query().Get("all")!="1"{t.Errorf("unexpected list request: %s",r.URL)};w.Header().Set("Content-Type","application/json");w.Write([]byte(`[{"Id":"aaaaaaaaaaaa","Names":["/api"],"Image":"example:1","State":"running","Status":"Up","Ports":[]}]`))})
 mux.HandleFunc("/containers/aaaaaaaaaaaa/restart",func(w http.ResponseWriter,r *http.Request){calls++;if r.Method!="POST" || r.URL.Query().Get("t")!="10"{t.Errorf("unexpected restart request: %s",r.URL)};w.WriteHeader(204)})
 server:=&http.Server{Handler:mux};go server.Serve(listener);defer server.Close()
 t.Setenv("CLOUDDECK_DOCKER_SOCKET",socket)
 result:=executeCommand(agentCommand{Type:"command",RequestID:"r1",Action:"docker.listContainers",Payload:json.RawMessage(`{}`)})
 if !result.Success {t.Fatalf("list failed: %s",result.Error)}
 rows:=result.Data.([]containerSummary);if len(rows)!=1 || rows[0].Name!="api"{t.Fatalf("unexpected containers: %+v",rows)}
 invalid:=executeCommand(agentCommand{Type:"command",RequestID:"r2",Action:"docker.restartContainer",Payload:json.RawMessage(`{"containerId":"../etc/passwd"}`)})
 if invalid.Success{t.Fatal("unsafe ID accepted")}
 denied:=executeCommand(agentCommand{Type:"command",RequestID:"r3",Action:"shell.execute",Payload:json.RawMessage(`{}`)})
 if denied.Success{t.Fatal("unlisted action accepted")}
 restart:=executeCommand(agentCommand{Type:"command",RequestID:"r4",Action:"docker.restartContainer",Payload:json.RawMessage(`{"containerId":"aaaaaaaaaaaa"}`)})
 if !restart.Success{t.Fatalf("restart failed: %s",restart.Error)}
 if calls!=2{t.Fatalf("expected two Docker calls, got %d",calls)}
}
