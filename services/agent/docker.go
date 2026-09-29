package main

import (
 "context"
 "encoding/json"
 "errors"
 "fmt"
 "io"
 "net"
 "net/http"
 "os"
 "regexp"
 "sort"
 "strings"
 "time"
)

type agentCommand struct {Type string `json:"type"`;RequestID string `json:"requestId"`;Action string `json:"action"`;Payload json.RawMessage `json:"payload"`}
type commandResult struct {Type string `json:"type"`;RequestID string `json:"requestId"`;Success bool `json:"success"`;Data any `json:"data,omitempty"`;Error string `json:"error,omitempty"`}
type dockerPort struct {PrivatePort int `json:"privatePort"`;PublicPort int `json:"publicPort,omitempty"`;Type string `json:"type"`}
type containerSummary struct {
 ID string `json:"id"`;Name string `json:"name"`;Image string `json:"image"`;State string `json:"state"`;Status string `json:"status"`;Ports []dockerPort `json:"ports"`
 ComposeProject string `json:"composeProject,omitempty"`;ComposeService string `json:"composeService,omitempty"`
}
type composeProjectSummary struct {Name string `json:"name"`;Services []string `json:"services"`;Running int `json:"running"`;Total int `json:"total"`}

var dockerID=regexp.MustCompile(`^[a-fA-F0-9]{12,64}$`)

func dockerClient() (*http.Client,error) {
 socket:=os.Getenv("CLOUDDECK_DOCKER_SOCKET");if socket==""{return nil,errors.New("Docker integration disabled on this agent")}
 if !strings.HasPrefix(socket,"/"){return nil,errors.New("Docker socket path must be absolute")}
 transport:=&http.Transport{DisableKeepAlives:true,DialContext:func(ctx context.Context,_,_ string)(net.Conn,error){var d net.Dialer;return d.DialContext(ctx,"unix",socket)}}
 return &http.Client{Transport:transport,Timeout:12*time.Second},nil
}
func dockerRequest(method,path string)(*http.Response,error){
 client,err:=dockerClient();if err!=nil{return nil,err}
 req,err:=http.NewRequest(method,"http://docker"+path,nil);if err!=nil{return nil,err}
 res,err:=client.Do(req);if err!=nil{return nil,errors.New("Docker Engine unavailable")}
 if res.StatusCode<200||res.StatusCode>=300{res.Body.Close();return nil,fmt.Errorf("Docker Engine returned HTTP %d",res.StatusCode)}
 return res,nil
}
func listContainers()([]containerSummary,error){
 res,err:=dockerRequest(http.MethodGet,"/containers/json?all=1&limit=200");if err!=nil{return nil,err};defer res.Body.Close()
 var rows []struct{
  ID string `json:"Id"`;Names []string `json:"Names"`;Image string `json:"Image"`;State string `json:"State"`;Status string `json:"Status"`
  Labels map[string]string `json:"Labels"`
  Ports []struct{PrivatePort int `json:"PrivatePort"`;PublicPort int `json:"PublicPort"`;Type string `json:"Type"`} `json:"Ports"`
 }
 if err:=json.NewDecoder(io.LimitReader(res.Body,512*1024)).Decode(&rows);err!=nil{return nil,errors.New("Invalid or oversized Docker response")}
 if len(rows)>200{return nil,errors.New("Too many containers for one response")}
 out:=make([]containerSummary,0,len(rows))
 for _,row:=range rows{
  if !dockerID.MatchString(row.ID){continue};name:="";if len(row.Names)>0{name=strings.TrimPrefix(row.Names[0],"/")}
  item:=containerSummary{ID:row.ID,Name:name,Image:row.Image,State:row.State,Status:row.Status,Ports:[]dockerPort{},ComposeProject:row.Labels["com.docker.compose.project"],ComposeService:row.Labels["com.docker.compose.service"]}
  for _,p:=range row.Ports{item.Ports=append(item.Ports,dockerPort{PrivatePort:p.PrivatePort,PublicPort:p.PublicPort,Type:p.Type})}
  out=append(out,item)
 }
 return out,nil
}
func listComposeProjects()([]composeProjectSummary,error){
 containers,err:=listContainers();if err!=nil{return nil,err}
 type acc struct{services map[string]struct{};running,total int};projects:=map[string]*acc{}
 for _,c:=range containers{
  if c.ComposeProject==""{continue};p:=projects[c.ComposeProject];if p==nil{p=&acc{services:map[string]struct{}{}};projects[c.ComposeProject]=p}
  p.total++;if c.State=="running"{p.running++};if c.ComposeService!=""{p.services[c.ComposeService]=struct{}{}}
 }
 names:=make([]string,0,len(projects));for name:=range projects{names=append(names,name)};sort.Strings(names)
 out:=make([]composeProjectSummary,0,len(names))
 for _,name:=range names{p:=projects[name];services:=make([]string,0,len(p.services));for s:=range p.services{services=append(services,s)};sort.Strings(services);out=append(out,composeProjectSummary{Name:name,Services:services,Running:p.running,Total:p.total})}
 return out,nil
}
func containerAction(id,action string)error{
 if !dockerID.MatchString(id){return errors.New("Invalid container ID")}
 method,path:=http.MethodPost,""
 switch action{
 case "start":path="/containers/"+id+"/start"
 case "stop":path="/containers/"+id+"/stop?t=10"
 case "restart":path="/containers/"+id+"/restart?t=10"
 case "pause":path="/containers/"+id+"/pause"
 case "unpause":path="/containers/"+id+"/unpause"
 case "remove":method=http.MethodDelete;path="/containers/"+id+"?v=0&force=0"
 default:return errors.New("Docker action not allowed")
 }
 res,err:=dockerRequest(method,path);if err!=nil{return err};defer res.Body.Close();return nil
}
func decodeStrict(payload json.RawMessage,target any)error{d:=json.NewDecoder(strings.NewReader(string(payload)));d.DisallowUnknownFields();return d.Decode(target)}
func executeCommand(command agentCommand)commandResult{
 result:=commandResult{Type:"command.result",RequestID:command.RequestID};if command.Type!="command"||command.RequestID==""{result.Error="Invalid command";return result}
 switch command.Action{
 case "docker.listContainers":
  if len(command.Payload)>0&&string(command.Payload)!="{}"{result.Error="Unexpected payload";return result};data,err:=listContainers();if err!=nil{result.Error=err.Error();return result};result.Data=data
 case "docker.listComposeProjects":
  if len(command.Payload)>0&&string(command.Payload)!="{}"{result.Error="Unexpected payload";return result};data,err:=listComposeProjects();if err!=nil{result.Error=err.Error();return result};result.Data=data
 case "docker.startContainer","docker.stopContainer","docker.restartContainer","docker.pauseContainer","docker.unpauseContainer","docker.removeContainer":
  var payload struct{ContainerID string `json:"containerId"`};if err:=decodeStrict(command.Payload,&payload);err!=nil||!dockerID.MatchString(payload.ContainerID){result.Error="Invalid container ID";return result}
  action:=strings.TrimPrefix(command.Action,"docker.");action=strings.TrimSuffix(action,"Container")
  if err:=containerAction(payload.ContainerID,action);err!=nil{result.Error=err.Error();return result};result.Data=map[string]bool{"ok":true}
 case "systemd.listServices":
  if len(command.Payload)>0&&string(command.Payload)!="{}"{result.Error="Unexpected payload";return result};data,err:=listSystemdServices();if err!=nil{result.Error=err.Error();return result};result.Data=data
 case "systemd.startService","systemd.stopService","systemd.restartService":
  var payload struct{ServiceName string `json:"serviceName"`};if err:=decodeStrict(command.Payload,&payload);err!=nil||!systemdServiceName.MatchString(payload.ServiceName){result.Error="Invalid service name";return result}
  op:=strings.TrimSuffix(strings.TrimPrefix(command.Action,"systemd."),"Service");if err:=controlSystemdService(payload.ServiceName,op);err!=nil{result.Error=err.Error();return result};result.Data=map[string]bool{"ok":true}
 case "systemd.tailLogs":
  var payload struct{ServiceName string `json:"serviceName"`;Limit int `json:"limit"`};if err:=decodeStrict(command.Payload,&payload);err!=nil||!systemdServiceName.MatchString(payload.ServiceName)||payload.Limit<1||payload.Limit>500{result.Error="Invalid log request";return result}
  lines,truncated,err:=tailSystemdLogs(payload.ServiceName,payload.Limit);if err!=nil{result.Error=err.Error();return result};result.Data=map[string]any{"lines":lines,"truncated":truncated}
 default:result.Error="Action not allowed";return result
 }
 result.Success=true;return result
}
