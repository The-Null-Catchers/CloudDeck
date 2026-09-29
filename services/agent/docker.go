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
var composeName=regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$`)

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

type containerInspect struct {
 Image string `json:"image"`
 Created string `json:"created"`
 RestartCount int `json:"restartCount"`
 Mounts []struct{Type string `json:"type"`;Source string `json:"source,omitempty"`;Destination string `json:"destination"`;ReadOnly bool `json:"readOnly"`} `json:"mounts"`
 Networks []string `json:"networks"`
 Ports []string `json:"ports"`
}
type containerStats struct {
 CPUPercent float64 `json:"cpuPercent"`
 MemoryUsage uint64 `json:"memoryUsage"`
 MemoryLimit uint64 `json:"memoryLimit"`
 NetworkRxBytes uint64 `json:"networkRxBytes"`
 NetworkTxBytes uint64 `json:"networkTxBytes"`
}

func inspectContainer(id string)(containerInspect,error){
 var out containerInspect
 if !dockerID.MatchString(id){return out,errors.New("Invalid container ID")}
 res,err:=dockerRequest(http.MethodGet,"/containers/"+id+"/json");if err!=nil{return out,err};defer res.Body.Close()
 var raw struct{
  Image string `json:"Image"`
  Created string `json:"Created"`
  RestartCount int `json:"RestartCount"`
  Mounts []struct{Type string `json:"Type"`;Source string `json:"Source"`;Destination string `json:"Destination"`;RW bool `json:"RW"`} `json:"Mounts"`
  NetworkSettings struct{
   Networks map[string]json.RawMessage `json:"Networks"`
   Ports map[string]json.RawMessage `json:"Ports"`
  } `json:"NetworkSettings"`
 }
 if err:=json.NewDecoder(io.LimitReader(res.Body,512*1024)).Decode(&raw);err!=nil{return out,errors.New("Invalid Docker inspect response")}
 out.Image=raw.Image;out.Created=raw.Created;out.RestartCount=raw.RestartCount
 out.Mounts=make([]struct{Type string `json:"type"`;Source string `json:"source,omitempty"`;Destination string `json:"destination"`;ReadOnly bool `json:"readOnly"`},0,len(raw.Mounts))
 for _,m:=range raw.Mounts{
  item:=struct{Type string `json:"type"`;Source string `json:"source,omitempty"`;Destination string `json:"destination"`;ReadOnly bool `json:"readOnly"`}{Type:m.Type,Destination:m.Destination,ReadOnly:!m.RW}
  if m.Type=="volume"{item.Source=m.Source}
  out.Mounts=append(out.Mounts,item)
 }
 for name:=range raw.NetworkSettings.Networks{out.Networks=append(out.Networks,name)}
 for port:=range raw.NetworkSettings.Ports{out.Ports=append(out.Ports,port)}
 sort.Strings(out.Networks);sort.Strings(out.Ports)
 return out,nil
}

func getContainerStats(id string)(containerStats,error){
 var out containerStats
 if !dockerID.MatchString(id){return out,errors.New("Invalid container ID")}
 res,err:=dockerRequest(http.MethodGet,"/containers/"+id+"/stats?stream=false&one-shot=true");if err!=nil{return out,err};defer res.Body.Close()
 var raw struct{
  CPUStats struct{CPUUsage struct{TotalUsage uint64 `json:"total_usage"`;PercpuUsage []uint64 `json:"percpu_usage"`} `json:"cpu_usage"`;SystemCPUUsage uint64 `json:"system_cpu_usage"`;OnlineCPUs uint64 `json:"online_cpus"`} `json:"cpu_stats"`
  PreCPUStats struct{CPUUsage struct{TotalUsage uint64 `json:"total_usage"`} `json:"cpu_usage"`;SystemCPUUsage uint64 `json:"system_cpu_usage"`} `json:"precpu_stats"`
  MemoryStats struct{Usage uint64 `json:"usage"`;Limit uint64 `json:"limit"`} `json:"memory_stats"`
  Networks map[string]struct{RxBytes uint64 `json:"rx_bytes"`;TxBytes uint64 `json:"tx_bytes"`} `json:"networks"`
 }
 if err:=json.NewDecoder(io.LimitReader(res.Body,512*1024)).Decode(&raw);err!=nil{return out,errors.New("Invalid Docker stats response")}
 cpuDelta:=raw.CPUStats.CPUUsage.TotalUsage-raw.PreCPUStats.CPUUsage.TotalUsage
 systemDelta:=raw.CPUStats.SystemCPUUsage-raw.PreCPUStats.SystemCPUUsage
 cpus:=raw.CPUStats.OnlineCPUs;if cpus==0{cpus=uint64(len(raw.CPUStats.CPUUsage.PercpuUsage))};if cpus==0{cpus=1}
 if systemDelta>0{out.CPUPercent=float64(cpuDelta)/float64(systemDelta)*float64(cpus)*100}
 out.MemoryUsage=raw.MemoryStats.Usage;out.MemoryLimit=raw.MemoryStats.Limit
 for _,n:=range raw.Networks{out.NetworkRxBytes+=n.RxBytes;out.NetworkTxBytes+=n.TxBytes}
 return out,nil
}

func tailContainerLogs(id string,limit int)([]string,bool,error){
 if !dockerID.MatchString(id){return nil,false,errors.New("Invalid container ID")}
 if limit<1||limit>500{return nil,false,errors.New("Invalid log limit")}
 res,err:=dockerRequest(http.MethodGet,fmt.Sprintf("/containers/%s/logs?stdout=1&stderr=1&timestamps=1&tail=%d",id,limit));if err!=nil{return nil,false,err};defer res.Body.Close()
 data,err:=io.ReadAll(io.LimitReader(res.Body,256*1024+1));if err!=nil{return nil,false,errors.New("Unable to read Docker logs")}
 truncated:=len(data)>256*1024;if truncated{data=data[:256*1024]}
 lines:=make([]string,0,limit)
 for len(data)>=8 && (data[0]==1||data[0]==2){
  size:=int(data[4])<<24|int(data[5])<<16|int(data[6])<<8|int(data[7]);if size<0||8+size>len(data){break}
  chunk:=strings.TrimSpace(string(data[8:8+size]));if chunk!=""{for _,line:=range strings.Split(chunk,"\n"){if len(line)>4000{line=line[:4000];truncated=true};lines=append(lines,line)}}
  data=data[8+size:];if len(lines)>=limit{break}
 }
 if len(lines)==0 && len(data)>0{for _,line:=range strings.Split(strings.TrimSpace(string(data)),"\n"){if line==""{continue};if len(line)>4000{line=line[:4000];truncated=true};lines=append(lines,line);if len(lines)>=limit{break}}}
 if len(lines)>limit{lines=lines[len(lines)-limit:]}
 return lines,truncated,nil
}

func composeServiceContainers(project,service string)([]containerSummary,error){
 if !composeName.MatchString(project)||!composeName.MatchString(service){return nil,errors.New("Invalid Compose project or service")}
 containers,err:=listContainers();if err!=nil{return nil,err}
 matches:=[]containerSummary{}
 for _,container:=range containers{
  if container.ComposeProject==project&&container.ComposeService==service{matches=append(matches,container)}
 }
 if len(matches)==0{return nil,errors.New("Compose service not found")}
 return matches,nil
}
func composeServiceAction(project,service,action string)error{
 containers,err:=composeServiceContainers(project,service);if err!=nil{return err}
 for _,container:=range containers{
  if action=="start"&&container.State=="running"{continue}
  if action=="stop"&&container.State!="running"&&container.State!="paused"{continue}
  if err:=containerAction(container.ID,action);err!=nil{return err}
 }
 return nil
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
 case "docker.startComposeService","docker.stopComposeService","docker.restartComposeService":
  var payload struct{Project string `json:"project"`;Service string `json:"service"`};if err:=decodeStrict(command.Payload,&payload);err!=nil||!composeName.MatchString(payload.Project)||!composeName.MatchString(payload.Service){result.Error="Invalid Compose project or service";return result}
  action:=strings.TrimSuffix(strings.TrimPrefix(command.Action,"docker."),"ComposeService")
  if err:=composeServiceAction(payload.Project,payload.Service,action);err!=nil{result.Error=err.Error();return result};result.Data=map[string]bool{"ok":true}
 case "docker.inspectContainer":
  var payload struct{ContainerID string `json:"containerId"`};if err:=decodeStrict(command.Payload,&payload);err!=nil||!dockerID.MatchString(payload.ContainerID){result.Error="Invalid container ID";return result}
  data,err:=inspectContainer(payload.ContainerID);if err!=nil{result.Error=err.Error();return result};result.Data=data
 case "docker.getContainerStats":
  var payload struct{ContainerID string `json:"containerId"`};if err:=decodeStrict(command.Payload,&payload);err!=nil||!dockerID.MatchString(payload.ContainerID){result.Error="Invalid container ID";return result}
  data,err:=getContainerStats(payload.ContainerID);if err!=nil{result.Error=err.Error();return result};result.Data=data
 case "docker.tailContainerLogs":
  var payload struct{ContainerID string `json:"containerId"`;Limit int `json:"limit"`};if err:=decodeStrict(command.Payload,&payload);err!=nil||!dockerID.MatchString(payload.ContainerID)||payload.Limit<1||payload.Limit>500{result.Error="Invalid log request";return result}
  lines,truncated,err:=tailContainerLogs(payload.ContainerID,payload.Limit);if err!=nil{result.Error=err.Error();return result};result.Data=map[string]any{"lines":lines,"truncated":truncated}
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
