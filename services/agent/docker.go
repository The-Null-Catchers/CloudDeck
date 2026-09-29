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
 "strings"
 "time"
)

type agentCommand struct {
 Type string `json:"type"`
 RequestID string `json:"requestId"`
 Action string `json:"action"`
 Payload json.RawMessage `json:"payload"`
}
type commandResult struct {
 Type string `json:"type"`
 RequestID string `json:"requestId"`
 Success bool `json:"success"`
 Data any `json:"data,omitempty"`
 Error string `json:"error,omitempty"`
}
type dockerPort struct {
 PrivatePort int `json:"privatePort"`
 PublicPort int `json:"publicPort,omitempty"`
 Type string `json:"type"`
}
type containerSummary struct {
 ID string `json:"id"`
 Name string `json:"name"`
 Image string `json:"image"`
 State string `json:"state"`
 Status string `json:"status"`
 Ports []dockerPort `json:"ports"`
}

var dockerID = regexp.MustCompile(`^[a-fA-F0-9]{12,64}$`)

func dockerClient() (*http.Client,error) {
 socket:=os.Getenv("CLOUDDECK_DOCKER_SOCKET")
 if socket=="" {return nil,errors.New("Docker integration disabled on this agent")}
 if !strings.HasPrefix(socket,"/"){return nil,errors.New("Docker socket path must be absolute")}
 transport:=&http.Transport{DisableKeepAlives:true,DialContext:func(ctx context.Context,_,_ string)(net.Conn,error){var dialer net.Dialer;return dialer.DialContext(ctx,"unix",socket)}}
 return &http.Client{Transport:transport,Timeout:10*time.Second},nil
}
func dockerRequest(method,path string) (*http.Response,error) {
 client,err:=dockerClient();if err!=nil{return nil,err}
 request,err:=http.NewRequest(method,"http://docker"+path,nil);if err!=nil{return nil,err}
 response,err:=client.Do(request);if err!=nil{return nil,errors.New("Docker Engine unavailable")}
 if response.StatusCode<200 || response.StatusCode>=300 {response.Body.Close();return nil,fmt.Errorf("Docker Engine returned HTTP %d",response.StatusCode)}
 return response,nil
}
func listContainers() ([]containerSummary,error) {
 response,err:=dockerRequest(http.MethodGet,"/containers/json?all=1&limit=200");if err!=nil{return nil,err};defer response.Body.Close()
 var rows []struct {
  ID string `json:"Id"`
  Names []string `json:"Names"`
  Image string `json:"Image"`
  State string `json:"State"`
  Status string `json:"Status"`
  Ports []struct{PrivatePort int `json:"PrivatePort"`;PublicPort int `json:"PublicPort"`;Type string `json:"Type"`} `json:"Ports"`
 }
 if err:=json.NewDecoder(io.LimitReader(response.Body,256*1024)).Decode(&rows);err!=nil{return nil,errors.New("Invalid or oversized Docker response")}
 if len(rows)>200{return nil,errors.New("Too many containers for one response")}
 result:=make([]containerSummary,0,len(rows))
 for _,row:=range rows {
  if !dockerID.MatchString(row.ID){continue}
  name:="";if len(row.Names)>0{name=strings.TrimPrefix(row.Names[0],"/")}
  item:=containerSummary{ID:row.ID,Name:name,Image:row.Image,State:row.State,Status:row.Status,Ports:make([]dockerPort,0,len(row.Ports))}
  for _,port:=range row.Ports {item.Ports=append(item.Ports,dockerPort{PrivatePort:port.PrivatePort,PublicPort:port.PublicPort,Type:port.Type})}
  result=append(result,item)
 }
 return result,nil
}
func restartContainer(id string) error {
 if !dockerID.MatchString(id){return errors.New("Invalid container ID")}
 response,err:=dockerRequest(http.MethodPost,"/containers/"+id+"/restart?t=10");if err!=nil{return err};defer response.Body.Close()
 return nil
}

func decodeStrict(payload json.RawMessage,target any) error {
 decoder:=json.NewDecoder(strings.NewReader(string(payload)));decoder.DisallowUnknownFields()
 return decoder.Decode(target)
}

func executeCommand(command agentCommand) commandResult {
 result:=commandResult{Type:"command.result",RequestID:command.RequestID}
 if command.Type!="command" || command.RequestID==""{result.Error="Invalid command";return result}
 switch command.Action {
 case "docker.listContainers":
  if len(command.Payload)>0 && string(command.Payload)!="{}" {result.Error="Unexpected payload";return result}
  data,err:=listContainers();if err!=nil{result.Error=err.Error();return result};result.Data=data
 case "docker.restartContainer":
  var payload struct{ContainerID string `json:"containerId"`}
  if err:=decodeStrict(command.Payload,&payload);err!=nil || !dockerID.MatchString(payload.ContainerID){result.Error="Invalid container ID";return result}
  if err:=restartContainer(payload.ContainerID);err!=nil{result.Error=err.Error();return result}
  result.Data=map[string]bool{"restarted":true}
 case "systemd.listServices":
  if len(command.Payload)>0 && string(command.Payload)!="{}" {result.Error="Unexpected payload";return result}
  data,err:=listSystemdServices();if err!=nil{result.Error=err.Error();return result};result.Data=data
 case "systemd.startService","systemd.stopService","systemd.restartService":
  var payload struct{ServiceName string `json:"serviceName"`}
  if err:=decodeStrict(command.Payload,&payload);err!=nil || !systemdServiceName.MatchString(payload.ServiceName){result.Error="Invalid service name";return result}
  operation:=strings.TrimPrefix(command.Action,"systemd.")
  operation=strings.TrimSuffix(operation,"Service")
  if err:=controlSystemdService(payload.ServiceName,operation);err!=nil{result.Error=err.Error();return result}
  result.Data=map[string]bool{"ok":true}
 case "systemd.tailLogs":
  var payload struct{ServiceName string `json:"serviceName"`;Limit int `json:"limit"`}
  if err:=decodeStrict(command.Payload,&payload);err!=nil || !systemdServiceName.MatchString(payload.ServiceName) || payload.Limit<1 || payload.Limit>500 {result.Error="Invalid log request";return result}
  lines,truncated,err:=tailSystemdLogs(payload.ServiceName,payload.Limit);if err!=nil{result.Error=err.Error();return result}
  result.Data=map[string]any{"lines":lines,"truncated":truncated}
 default:result.Error="Action not allowed";return result
 }
 result.Success=true
 return result
}
