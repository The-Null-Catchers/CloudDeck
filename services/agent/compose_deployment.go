package main

import (
 "context"
 "encoding/json"
 "errors"
 "fmt"
 "io"
 "net/http"
 "net/url"
 "os"
 "path/filepath"
 "sort"
 "strconv"
 "strings"
 "time"

 "gopkg.in/yaml.v3"
)

type composeSpec struct {
 Version string `yaml:"version,omitempty"`
 Name string `yaml:"name,omitempty"`
 Services map[string]composeDeployService `yaml:"services"`
}
type composeDeployService struct {
 Image string `yaml:"image,omitempty"`
 Build string `yaml:"build,omitempty"`
 Ports []string `yaml:"ports,omitempty"`
 Environment map[string]any `yaml:"environment,omitempty"`
 Restart string `yaml:"restart,omitempty"`
 DependsOn []string `yaml:"depends_on,omitempty"`
 Volumes []string `yaml:"volumes,omitempty"`
 Networks []string `yaml:"networks,omitempty"`
 Privileged bool `yaml:"privileged,omitempty"`
 Devices []string `yaml:"devices,omitempty"`
 NetworkMode string `yaml:"network_mode,omitempty"`
 Command any `yaml:"command,omitempty"`
 Entrypoint any `yaml:"entrypoint,omitempty"`
}
type composeDeploymentResult struct {
 ComposeContainerIDs map[string]string `json:"composeContainerIds"`
 PreviousComposeContainerIDs map[string]string `json:"previousComposeContainerIds,omitempty"`
}

func parseComposeSpec(path string)(composeSpec,error){
 var spec composeSpec
 f,err:=os.Open(path);if err!=nil{return spec,errors.New("Configured Compose file is missing")}
 defer f.Close()
 dec:=yaml.NewDecoder(io.LimitReader(f,2<<20));dec.KnownFields(true)
 if err:=dec.Decode(&spec);err!=nil{return spec,errors.New("Unsupported or invalid Compose file")}
 if len(spec.Services)==0||len(spec.Services)>50{return spec,errors.New("Compose file must contain 1-50 services")}
 for name,svc:=range spec.Services{
  if !composeName.MatchString(name){return spec,fmt.Errorf("Invalid Compose service name: %s",name)}
  if svc.Image==""&&svc.Build==""{return spec,fmt.Errorf("Compose service %s requires image or build",name)}
  if svc.Image!=""&&len(svc.Image)>255{return spec,fmt.Errorf("Compose service %s image is too long",name)}
  if svc.Build!=""{
   clean:=filepath.Clean(svc.Build)
   if filepath.IsAbs(clean)||clean==".."||strings.HasPrefix(clean,".."+string(filepath.Separator)){return spec,fmt.Errorf("Compose service %s has unsafe build context",name)}
  }
  if len(svc.Volumes)>0||len(svc.Networks)>0||svc.Privileged||len(svc.Devices)>0||svc.NetworkMode!=""||svc.Command!=nil||svc.Entrypoint!=nil{
   return spec,fmt.Errorf("Compose service %s uses a feature not supported by the safe executor",name)
  }
  switch svc.Restart{case "","no","always","unless-stopped","on-failure":default:return spec,fmt.Errorf("Compose service %s has unsupported restart policy",name)}
  if len(svc.Ports)>32{return spec,fmt.Errorf("Compose service %s exposes too many ports",name)}
  for _,dep:=range svc.DependsOn{if !composeName.MatchString(dep){return spec,fmt.Errorf("Compose service %s has invalid dependency",name)}}
 }
 for name,svc:=range spec.Services{for _,dep:=range svc.DependsOn{if _,ok:=spec.Services[dep];!ok{return spec,fmt.Errorf("Compose service %s depends on unknown service %s",name,dep)}}}
 if _,err:=composeStartOrder(spec.Services);err!=nil{return spec,err}
 return spec,nil
}

func composeStartOrder(services map[string]composeDeployService)([]string,error){
 state:=map[string]uint8{};order:=make([]string,0,len(services))
 var visit func(string)error
 visit=func(name string)error{
  if state[name]==2{return nil};if state[name]==1{return errors.New("Compose dependency cycle detected")}
  state[name]=1
  deps:=append([]string(nil),services[name].DependsOn...);sort.Strings(deps)
  for _,dep:=range deps{if err:=visit(dep);err!=nil{return err}}
  state[name]=2;order=append(order,name);return nil
 }
 names:=make([]string,0,len(services));for name:=range services{names=append(names,name)};sort.Strings(names)
 for _,name:=range names{if err:=visit(name);err!=nil{return nil,err}}
 return order,nil
}

func composeEnvironment(values map[string]any)([]string,error){
 if len(values)>200{return nil,errors.New("Too many Compose environment variables")}
 keys:=make([]string,0,len(values));for key:=range values{keys=append(keys,key)};sort.Strings(keys)
 out:=make([]string,0,len(keys))
 for _,key:=range keys{
  if key==""||len(key)>128||strings.ContainsAny(key,"=\x00\r\n"){return nil,errors.New("Invalid Compose environment key")}
  value:=values[key];var text string
  switch v:=value.(type){case nil:text="";case string:text=v;case int:text=strconv.Itoa(v);case int64:text=strconv.FormatInt(v,10);case float64:text=strconv.FormatFloat(v,'g',-1,64);case bool:text=strconv.FormatBool(v);default:return nil,errors.New("Compose environment values must be scalar")}
  if len(text)>8192||strings.ContainsRune(text,'\x00'){return nil,errors.New("Invalid Compose environment value")}
  out=append(out,key+"="+text)
 }
 return out,nil
}

func composePortBindings(ports []string)(map[string]any,map[string]any,error){
 exposed:=map[string]any{};bindings:=map[string]any{}
 for _,raw:=range ports{
  protocol:="tcp";value:=strings.TrimSpace(raw)
  if slash:=strings.LastIndex(value,"/");slash>=0{protocol=value[slash+1:];value=value[:slash]}
  if protocol!="tcp"&&protocol!="udp"{return nil,nil,errors.New("Unsupported Compose port protocol")}
  parts:=strings.Split(value,":");var host,container int;var err error
  switch len(parts){
  case 1:container,err=strconv.Atoi(parts[0])
  case 2:host,err=strconv.Atoi(parts[0]);if err==nil{container,err=strconv.Atoi(parts[1])}
  default:return nil,nil,errors.New("Only host:container or container Compose ports are supported")
  }
  if err!=nil||container<1||container>65535||host<0||host>65535{return nil,nil,errors.New("Invalid Compose port mapping")}
  key:=strconv.Itoa(container)+"/"+protocol;exposed[key]=map[string]any{}
  if host>0{bindings[key]=[]map[string]string{{"HostPort":strconv.Itoa(host)}}}
 }
 return exposed,bindings,nil
}

func ensureComposeNetwork(ctx context.Context,client *http.Client,project string)error{
 name:=project+"_default"
 res,err:=dockerJSON(ctx,client,http.MethodGet,"/networks/"+url.PathEscape(name),nil)
 if err==nil{
  if res.StatusCode>=200&&res.StatusCode<300{res.Body.Close();return nil}
  res.Body.Close()
 }
 body,_:=json.Marshal(map[string]any{"Name":name,"Driver":"bridge","CheckDuplicate":true,"Labels":map[string]string{"com.docker.compose.project":project,"com.docker.compose.network":"default"}})
 res,err=dockerJSON(ctx,client,http.MethodPost,"/networks/create",strings.NewReader(string(body)));if err!=nil{return err}
 if res.StatusCode==http.StatusConflict{res.Body.Close();return nil}
 return expectDockerStatus(res,http.StatusCreated)
}

func pullComposeImage(ctx context.Context,client *http.Client,deploymentID,service,image string,write func(any)error)error{
 if image==""||strings.ContainsAny(image,"\r\n\x00"){return errors.New("Invalid image reference")}
 q:=url.Values{};q.Set("fromImage",image)
 res,err:=dockerJSON(ctx,client,http.MethodPost,"/images/create?"+q.Encode(),nil);if err!=nil{return err}
 defer res.Body.Close();if res.StatusCode<200||res.StatusCode>=300{return fmt.Errorf("Docker image pull returned HTTP %d",res.StatusCode)}
 dec:=json.NewDecoder(io.LimitReader(res.Body,32<<20))
 for{
  var msg struct{Status string `json:"status"`;ID string `json:"id"`;Progress string `json:"progress"`;Error string `json:"error"`}
  err:=dec.Decode(&msg);if errors.Is(err,io.EOF){break};if err!=nil{return errors.New("Invalid Docker image pull response")}
  if msg.Status!=""{line:=service+": "+msg.Status;if msg.ID!=""{line+=" "+msg.ID};if msg.Progress!=""{line+=" "+msg.Progress};emitDeploymentLog(write,deploymentID,"building","build",line)}
  if msg.Error!=""{emitDeploymentLog(write,deploymentID,"building","stderr",service+": "+msg.Error);return errors.New("Docker image pull failed")}
 }
 return nil
}

func buildComposeServiceImage(ctx context.Context,root,project,deploymentID,service,buildPath string,write func(any)error)(string,error){
 contextRoot:=filepath.Join(root,filepath.Clean(buildPath));info,err:=os.Stat(contextRoot);if err!=nil||!info.IsDir(){return "",fmt.Errorf("Build context for %s is missing",service)}
 imageRef:="clouddeck/"+strings.ToLower(project)+"-"+strings.ToLower(service)+":"+strings.ToLower(deploymentID[:8])
 client,err:=deploymentHTTPClient(20*time.Minute);if err!=nil{return "",err}
 pr,pw:=io.Pipe();go func(){err:=writeBuildContext(ctx,contextRoot,pw);_ = pw.CloseWithError(err)}()
 q:=url.Values{};q.Set("t",imageRef);q.Set("dockerfile","Dockerfile");q.Set("rm","1");q.Set("forcerm","1")
 req,err:=http.NewRequestWithContext(ctx,http.MethodPost,"http://docker/build?"+q.Encode(),pr);if err!=nil{return "",err};req.Header.Set("Content-Type","application/x-tar")
 res,err:=client.Do(req);if err!=nil{return "",errors.New("Docker Compose service build request failed")}
 defer res.Body.Close();if res.StatusCode<200||res.StatusCode>=300{return "",fmt.Errorf("Docker build returned HTTP %d",res.StatusCode)}
 dec:=json.NewDecoder(io.LimitReader(res.Body,32<<20))
 for{
  var msg struct{Stream string `json:"stream"`;Status string `json:"status"`;Progress string `json:"progress"`;Error string `json:"error"`}
  err:=dec.Decode(&msg);if errors.Is(err,io.EOF){break};if err!=nil{return "",errors.New("Invalid Docker build response")}
  if msg.Stream!=""{for _,line:=range strings.Split(msg.Stream,"\n"){emitDeploymentLog(write,deploymentID,"building","build",service+": "+line)}}
  if msg.Status!=""{line:=service+": "+msg.Status;if msg.Progress!=""{line+=" "+msg.Progress};emitDeploymentLog(write,deploymentID,"building","build",line)}
  if msg.Error!=""{emitDeploymentLog(write,deploymentID,"building","stderr",service+": "+msg.Error);return "",errors.New("Docker Compose service build failed")}
 }
 return imageRef,nil
}

func existingComposeContainers(project string)(map[string]string,error){
 containers,err:=listContainers();if err!=nil{return nil,err}
 result:=map[string]string{}
 for _,container:=range containers{
  if container.ComposeProject==project&&container.ComposeService!=""{
   if _,exists:=result[container.ComposeService];exists{return nil,errors.New("Scaled Compose services are not supported by deployment executor")}
   result[container.ComposeService]=container.ID
  }
 }
 return result,nil
}

func deployComposeProject(ctx context.Context,root string,p deploymentExecutePayload,write func(any)error)(composeDeploymentResult,error){
 var result composeDeploymentResult
 if p.Runtime.ComposeProject==nil||!composeName.MatchString(*p.Runtime.ComposeProject){return result,errors.New("Invalid Compose project target")}
 specPath:=filepath.Join(root,filepath.Clean(p.SourcePath));spec,err:=parseComposeSpec(specPath);if err!=nil{return result,err}
 project:=*p.Runtime.ComposeProject;order,err:=composeStartOrder(spec.Services);if err!=nil{return result,err}
 client,err:=deploymentHTTPClient(20*time.Minute);if err!=nil{return result,err}
 if err:=ensureComposeNetwork(ctx,client,project);err!=nil{return result,err}
 images:=map[string]string{}
 emitDeploymentProgress(write,p.DeploymentID,"building","Preparing Compose service images")
 for _,name:=range order{
  svc:=spec.Services[name]
  emitDeploymentLog(write,p.DeploymentID,"building","system","Preparing Compose service "+name)
  if svc.Build!=""{images[name],err=buildComposeServiceImage(ctx,root,project,p.DeploymentID,name,svc.Build,write)}else{images[name]=svc.Image;err=pullComposeImage(ctx,client,p.DeploymentID,name,svc.Image,write)}
  if err!=nil{return result,fmt.Errorf("Compose service %s image preparation failed",name)}
 }
 previous,err:=existingComposeContainers(project);if err!=nil{return result,err}
 prepared:=map[string]string{}
 restorePrepared:=func(){
  for service,id:=range prepared{
   name:=project+"-"+service+"-1"
   if res,err:=dockerJSON(context.Background(),client,http.MethodPost,"/containers/"+url.PathEscape(id)+"/rename?name="+url.QueryEscape(name),nil);err==nil{_ = expectDockerStatus(res,204)}
   if res,err:=dockerJSON(context.Background(),client,http.MethodPost,"/containers/"+url.PathEscape(id)+"/start",nil);err==nil{_ = expectDockerStatus(res,204,304)}
  }
 }
 for service,id:=range previous{
  if res,err:=dockerJSON(ctx,client,http.MethodPost,"/containers/"+url.PathEscape(id)+"/stop?t=15",nil);err!=nil{restorePrepared();return result,err}else if err:=expectDockerStatus(res,204,304);err!=nil{restorePrepared();return result,err}
  backup:=project+"-"+service+"-clouddeck-prev-"+strings.ToLower(p.DeploymentID[:8]);if len(backup)>127{backup=backup[:127]}
  if res,err:=dockerJSON(ctx,client,http.MethodPost,"/containers/"+url.PathEscape(id)+"/rename?name="+url.QueryEscape(backup),nil);err!=nil{restorePrepared();return result,err}else if err:=expectDockerStatus(res,204);err!=nil{restorePrepared();return result,err}
  prepared[service]=id
 }
 created:=map[string]string{}
 restore:=func(){
  for _,id:=range created{if res,err:=dockerJSON(context.Background(),client,http.MethodDelete,"/containers/"+url.PathEscape(id)+"?force=1",nil);err==nil{_ = expectDockerStatus(res,204)}}
  restorePrepared()
 }
 emitDeploymentProgress(write,p.DeploymentID,"deploying","Creating and starting Compose services")
 for _,name:=range order{
  svc:=spec.Services[name];env,err:=composeEnvironment(svc.Environment);if err!=nil{restore();return result,err}
  exposed,bindings,err:=composePortBindings(svc.Ports);if err!=nil{restore();return result,err}
  restart:=svc.Restart;if restart==""{restart="no"}
  config:=map[string]any{
   "Image":images[name],"Env":env,"ExposedPorts":exposed,
   "Labels":map[string]string{"com.docker.compose.project":project,"com.docker.compose.service":name,"com.docker.compose.container-number":"1","clouddeck.deployment.id":p.DeploymentID},
   "HostConfig":map[string]any{"RestartPolicy":map[string]any{"Name":restart},"PortBindings":bindings},
   "NetworkingConfig":map[string]any{"EndpointsConfig":map[string]any{project+"_default":map[string]any{}}},
  }
  encoded,_:=json.Marshal(config);containerName:=project+"-"+name+"-1"
  res,err:=dockerJSON(ctx,client,http.MethodPost,"/containers/create?name="+url.QueryEscape(containerName),strings.NewReader(string(encoded)));if err!=nil{restore();return result,err}
  if res.StatusCode<200||res.StatusCode>=300{res.Body.Close();restore();return result,fmt.Errorf("Compose service %s create failed",name)}
  var createdRes struct{ID string `json:"Id"`};decodeErr:=json.NewDecoder(io.LimitReader(res.Body,64<<10)).Decode(&createdRes);res.Body.Close();if decodeErr!=nil||createdRes.ID==""{restore();return result,errors.New("Invalid Docker create response")}
  created[name]=createdRes.ID
  emitDeploymentLog(write,p.DeploymentID,"deploying","system","Created Compose service "+name+" as "+createdRes.ID[:12])
  start,err:=dockerJSON(ctx,client,http.MethodPost,"/containers/"+url.PathEscape(createdRes.ID)+"/start",nil);if err!=nil{restore();return result,err};if err:=expectDockerStatus(start,204,304);err!=nil{restore();return result,err}
  emitDeploymentLog(write,p.DeploymentID,"deploying","system","Started Compose service "+name+"; waiting for readiness")
  if err:=waitContainerReady(ctx,client,createdRes.ID,45*time.Second);err!=nil{emitContainerRuntimeLogs(write,p.DeploymentID,createdRes.ID);restore();return result,fmt.Errorf("Compose service %s readiness failed",name)}
  emitDeploymentLog(write,p.DeploymentID,"health-checking","system","Compose service "+name+" is ready")
  emitContainerRuntimeLogs(write,p.DeploymentID,createdRes.ID)
 }
 emitDeploymentProgress(write,p.DeploymentID,"health-checking","All Compose services are running and ready")
 result.ComposeContainerIDs=created;result.PreviousComposeContainerIDs=previous;return result,nil
}
