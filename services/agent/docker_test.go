package main

import (
 "encoding/json"
 "net"
 "net/http"
 "path/filepath"
 "testing"
)

func TestDockerLifecycleAndCompose(t *testing.T){
 socket:=filepath.Join(t.TempDir(),"docker.sock");listener,err:=net.Listen("unix",socket);if err!=nil{t.Fatal(err)}
 mux:=http.NewServeMux();calls:=map[string]int{}
 mux.HandleFunc("/containers/json",func(w http.ResponseWriter,r *http.Request){calls["list"]++;w.Header().Set("Content-Type","application/json");w.Write([]byte(`[{"Id":"aaaaaaaaaaaa","Names":["/api"],"Image":"example:1","State":"running","Status":"Up","Labels":{"com.docker.compose.project":"clouddeck","com.docker.compose.service":"api"},"Ports":[]},{"Id":"bbbbbbbbbbbb","Names":["/db"],"Image":"postgres:17","State":"exited","Status":"Exited","Labels":{"com.docker.compose.project":"clouddeck","com.docker.compose.service":"db"},"Ports":[]}]`))})
 for _,action:=range []string{"start","stop","restart","pause","unpause"}{
  action:=action;path:="/containers/aaaaaaaaaaaa/"+action;mux.HandleFunc(path,func(w http.ResponseWriter,r *http.Request){calls[action]++;w.WriteHeader(204)})
 }
 mux.HandleFunc("/containers/aaaaaaaaaaaa",func(w http.ResponseWriter,r *http.Request){if r.Method!=http.MethodDelete{t.Errorf("expected DELETE")};calls["remove"]++;w.WriteHeader(204)})
 server:=&http.Server{Handler:mux};go server.Serve(listener);defer server.Close();t.Setenv("CLOUDDECK_DOCKER_SOCKET",socket)

 list:=executeCommand(agentCommand{Type:"command",RequestID:"1",Action:"docker.listContainers",Payload:json.RawMessage(`{}`)});if !list.Success{t.Fatal(list.Error)}
 rows:=list.Data.([]containerSummary);if rows[0].ComposeProject!="clouddeck"{t.Fatalf("compose label missing: %+v",rows[0])}
 projects:=executeCommand(agentCommand{Type:"command",RequestID:"2",Action:"docker.listComposeProjects",Payload:json.RawMessage(`{}`)});if !projects.Success{t.Fatal(projects.Error)}
 p:=projects.Data.([]composeProjectSummary);if len(p)!=1||p[0].Running!=1||p[0].Total!=2{t.Fatalf("unexpected compose summary: %+v",p)}

 actions:=[]string{"start","stop","restart","pause","unpause","remove"}
 for i,a:=range actions{res:=executeCommand(agentCommand{Type:"command",RequestID:string(rune('a'+i)),Action:"docker."+a+"Container",Payload:json.RawMessage(`{"containerId":"aaaaaaaaaaaa"}`)});if !res.Success{t.Fatalf("%s failed: %s",a,res.Error)}}
 composeStart:=executeCommand(agentCommand{Type:"command",RequestID:"compose",Action:"docker.startComposeService",Payload:json.RawMessage(`{"project":"clouddeck","service":"api"}`)});if !composeStart.Success{t.Fatalf("compose start failed: %s",composeStart.Error)}
 invalidCompose:=executeCommand(agentCommand{Type:"command",RequestID:"bad-compose",Action:"docker.restartComposeService",Payload:json.RawMessage(`{"project":"../clouddeck","service":"api"}`)});if invalidCompose.Success{t.Fatal("unsafe Compose name accepted")}
 invalid:=executeCommand(agentCommand{Type:"command",RequestID:"x",Action:"docker.removeContainer",Payload:json.RawMessage(`{"containerId":"../etc/passwd"}`)});if invalid.Success{t.Fatal("unsafe ID accepted")}
 denied:=executeCommand(agentCommand{Type:"command",RequestID:"y",Action:"docker.exec",Payload:json.RawMessage(`{}`)});if denied.Success{t.Fatal("unlisted action accepted")}
}
