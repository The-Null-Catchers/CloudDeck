package main

import (
 "archive/tar"
 "compress/gzip"
 "context"
 "encoding/json"
 "errors"
 "fmt"
 "io"
 "net"
 "net/http"
 "net/url"
 "os"
 "path/filepath"
 "regexp"
 "strconv"
 "strings"
 "time"
)

var deploymentUUID=regexp.MustCompile(`^[a-fA-F0-9-]{36}$`)
var commitSHA=regexp.MustCompile(`^[a-fA-F0-9]{40}$`)
var repoName=regexp.MustCompile(`^[A-Za-z0-9-]{1,100}/[A-Za-z0-9_.-]{1,100}$`)

type deploymentRuntime struct {
 ContainerName *string `json:"containerName"`
 ContainerPort *int `json:"containerPort"`
 HostPort *int `json:"hostPort"`
 RestartPolicy *string `json:"restartPolicy"`
 ComposeProject *string `json:"composeProject"`
}
type deploymentExecutePayload struct {
 DeploymentID string `json:"deploymentId"`
 RepositoryFullName string `json:"repositoryFullName"`
 CommitSHA string `json:"commitSha"`
 SourcePath string `json:"sourcePath"`
 DeploymentType string `json:"deploymentType"`
 GithubToken string `json:"githubToken"`
 Runtime deploymentRuntime `json:"runtime"`
}
type deploymentExecuteResult struct {
 ContainerID string `json:"containerId"`
 ImageRef string `json:"imageRef"`
 PreviousContainerID *string `json:"previousContainerId,omitempty"`
}

func validateDeploymentPayload(p deploymentExecutePayload) error {
 if !deploymentUUID.MatchString(p.DeploymentID) || !repoName.MatchString(p.RepositoryFullName) || !commitSHA.MatchString(p.CommitSHA) {return errors.New("Invalid deployment identity")}
 if p.DeploymentType!="dockerfile" {return errors.New("Only Dockerfile deployments are supported by this executor")}
 if p.GithubToken=="" || len(p.GithubToken)>1000 || strings.ContainsAny(p.GithubToken,"\r\n ") {return errors.New("Invalid GitHub credential")}
 if p.SourcePath=="" || filepath.IsAbs(p.SourcePath) || strings.Contains(p.SourcePath,"..") {return errors.New("Invalid Dockerfile path")}
 if p.Runtime.ContainerName==nil || !composeName.MatchString(*p.Runtime.ContainerName) {return errors.New("Invalid container runtime target")}
 if p.Runtime.RestartPolicy==nil {return errors.New("Missing restart policy")}
 switch *p.Runtime.RestartPolicy {case "no","always","unless-stopped","on-failure":default:return errors.New("Invalid restart policy")}
 if p.Runtime.ContainerPort!=nil && (*p.Runtime.ContainerPort<1||*p.Runtime.ContainerPort>65535){return errors.New("Invalid container port")}
 if p.Runtime.HostPort!=nil {
  if p.Runtime.ContainerPort==nil || *p.Runtime.HostPort<1 || *p.Runtime.HostPort>65535 {return errors.New("Invalid host port")}
 }
 return nil
}

func deploymentHTTPClient(timeout time.Duration)(*http.Client,error){
 socket:=os.Getenv("CLOUDDECK_DOCKER_SOCKET");if socket==""{return nil,errors.New("Docker integration disabled on this agent")}
 if !strings.HasPrefix(socket,"/"){return nil,errors.New("Docker socket path must be absolute")}
 transport:=&http.Transport{DisableKeepAlives:true,DialContext:func(ctx context.Context,_,_ string)(net.Conn,error){var d net.Dialer;return d.DialContext(ctx,"unix",socket)}}
 return &http.Client{Transport:transport,Timeout:timeout},nil
}

func emitDeploymentProgress(write func(any)error,id,stage,message string){
 _=write(map[string]any{"type":"deployment.progress","deploymentId":id,"stage":stage,"message":message})
}

func downloadDeploymentSource(ctx context.Context,p deploymentExecutePayload)(string,error){
 root,err:=os.MkdirTemp("","clouddeck-deploy-*");if err!=nil{return "",err}
 cleanup:=func(){_ = os.RemoveAll(root)}
 parts:=strings.Split(p.RepositoryFullName,"/")
 endpoint:="https://api.github.com/repos/"+url.PathEscape(parts[0])+"/"+url.PathEscape(parts[1])+"/tarball/"+url.PathEscape(p.CommitSHA)
 req,err:=http.NewRequestWithContext(ctx,http.MethodGet,endpoint,nil);if err!=nil{cleanup();return "",err}
 req.Header.Set("Authorization","Bearer "+p.GithubToken)
 req.Header.Set("Accept","application/vnd.github+json")
 req.Header.Set("User-Agent","CloudDeck-Agent")
 client:=&http.Client{Timeout:2*time.Minute}
 res,err:=client.Do(req);if err!=nil{cleanup();return "",errors.New("Unable to download deployment source")}
 if res.StatusCode<200||res.StatusCode>=300{res.Body.Close();cleanup();return "",fmt.Errorf("GitHub source download returned HTTP %d",res.StatusCode)}
 gz,err:=gzip.NewReader(io.LimitReader(res.Body,256<<20));if err!=nil{res.Body.Close();cleanup();return "",errors.New("Invalid source archive")}
 defer res.Body.Close();defer gz.Close()
 tr:=tar.NewReader(gz);files:=0;var total int64
 for {
  h,err:=tr.Next();if errors.Is(err,io.EOF){break};if err!=nil{cleanup();return "",errors.New("Invalid source archive")}
  name:=strings.TrimPrefix(filepath.ToSlash(h.Name),"./");segments:=strings.Split(name,"/");if len(segments)<2{continue}
  rel:=filepath.Clean(filepath.Join(segments[1:]...));if rel=="."||rel==""||filepath.IsAbs(rel)||strings.HasPrefix(rel,".."+string(filepath.Separator)){cleanup();return "",errors.New("Unsafe source archive path")}
  target:=filepath.Join(root,rel);if !strings.HasPrefix(target,root+string(filepath.Separator)){cleanup();return "",errors.New("Unsafe source archive path")}
  switch h.Typeflag {
  case tar.TypeDir:
   if err:=os.MkdirAll(target,0700);err!=nil{cleanup();return "",err}
  case tar.TypeReg,tar.TypeRegA:
   files++;total+=h.Size;if files>20000||total>1<<30{cleanup();return "",errors.New("Source archive exceeds limits")}
   if err:=os.MkdirAll(filepath.Dir(target),0700);err!=nil{cleanup();return "",err}
   mode:=os.FileMode(0600);if h.FileInfo().Mode()&0111!=0{mode=0700}
   f,err:=os.OpenFile(target,os.O_CREATE|os.O_WRONLY|os.O_TRUNC,mode);if err!=nil{cleanup();return "",err}
   _,copyErr:=io.CopyN(f,tr,h.Size);closeErr:=f.Close();if copyErr!=nil||closeErr!=nil{cleanup();return "",errors.New("Unable to extract source archive")}
  default:
   cleanup();return "",errors.New("Unsupported source archive entry")
  }
 }
 dockerfile:=filepath.Join(root,filepath.Clean(p.SourcePath));info,err:=os.Stat(dockerfile);if err!=nil||!info.Mode().IsRegular(){cleanup();return "",errors.New("Configured Dockerfile is missing from source archive")}
 return root,nil
}

func writeBuildContext(ctx context.Context,root string,w io.Writer)error{
 tw:=tar.NewWriter(w);defer tw.Close()
 return filepath.Walk(root,func(path string,info os.FileInfo,err error)error{
  if err!=nil{return err};if ctx.Err()!=nil{return ctx.Err()};if path==root{return nil}
  rel,err:=filepath.Rel(root,path);if err!=nil{return err}
  h,err:=tar.FileInfoHeader(info,"");if err!=nil{return err};h.Name=filepath.ToSlash(rel)
  if err:=tw.WriteHeader(h);err!=nil{return err};if info.Mode().IsRegular(){f,err:=os.Open(path);if err!=nil{return err};_,copyErr:=io.Copy(tw,f);_ = f.Close();return copyErr};return nil
 })
}

func buildDeploymentImage(ctx context.Context,root string,p deploymentExecutePayload)(string,error){
 imageRef:="clouddeck/"+strings.ToLower(p.DeploymentID)+":"+strings.ToLower(p.CommitSHA[:12])
 client,err:=deploymentHTTPClient(20*time.Minute);if err!=nil{return "",err}
 pr,pw:=io.Pipe()
 go func(){err:=writeBuildContext(ctx,root,pw);_ = pw.CloseWithError(err)}()
 q:=url.Values{};q.Set("t",imageRef);q.Set("dockerfile",filepath.ToSlash(p.SourcePath));q.Set("rm","1");q.Set("forcerm","1")
 req,err:=http.NewRequestWithContext(ctx,http.MethodPost,"http://docker/build?"+q.Encode(),pr);if err!=nil{return "",err}
 req.Header.Set("Content-Type","application/x-tar")
 res,err:=client.Do(req);if err!=nil{return "",errors.New("Docker build request failed")}
 defer res.Body.Close();if res.StatusCode<200||res.StatusCode>=300{return "",fmt.Errorf("Docker build returned HTTP %d",res.StatusCode)}
 dec:=json.NewDecoder(io.LimitReader(res.Body,32<<20))
 for {
  var msg struct{Error string `json:"error"`};err:=dec.Decode(&msg);if errors.Is(err,io.EOF){break};if err!=nil{return "",errors.New("Invalid Docker build response")};if msg.Error!=""{return "",errors.New("Docker build failed")}
 }
 return imageRef,nil
}

func dockerJSON(ctx context.Context,client *http.Client,method,path string,body io.Reader)(*http.Response,error){
 req,err:=http.NewRequestWithContext(ctx,method,"http://docker"+path,body);if err!=nil{return nil,err}
 if body!=nil{req.Header.Set("Content-Type","application/json")}
 return client.Do(req)
}

func inspectNamedContainer(ctx context.Context,client *http.Client,name string)(string,bool,bool,error){
 res,err:=dockerJSON(ctx,client,http.MethodGet,"/containers/"+url.PathEscape(name)+"/json",nil);if err!=nil{return "",false,false,err}
 defer res.Body.Close();if res.StatusCode==http.StatusNotFound{return "",false,false,nil};if res.StatusCode<200||res.StatusCode>=300{return "",false,false,fmt.Errorf("Docker inspect returned HTTP %d",res.StatusCode)}
 var data struct{ID string `json:"Id"`;State struct{Running bool `json:"Running"`;Health *struct{Status string `json:"Status"`} `json:"Health"`} `json:"State"`}
 if err:=json.NewDecoder(io.LimitReader(res.Body,1<<20)).Decode(&data);err!=nil{return "",false,false,err}
 healthy:=data.State.Health==nil||data.State.Health.Status=="healthy"
 return data.ID,data.State.Running,healthy,nil
}

func expectDockerStatus(res *http.Response,allowed ...int)error{
 defer res.Body.Close();for _,code:=range allowed{if res.StatusCode==code{return nil}};return fmt.Errorf("Docker Engine returned HTTP %d",res.StatusCode)
}

func rollbackContainer(ctx context.Context,client *http.Client,newID,oldID,oldName string,oldWasRunning bool){
 if newID!=""{if res,err:=dockerJSON(ctx,client,http.MethodDelete,"/containers/"+url.PathEscape(newID)+"?force=1",nil);err==nil{_ = expectDockerStatus(res,204)}}
 if oldID!=""{
  if res,err:=dockerJSON(ctx,client,http.MethodPost,"/containers/"+url.PathEscape(oldID)+"/rename?name="+url.QueryEscape(oldName),nil);err==nil{_ = expectDockerStatus(res,204)}
  if oldWasRunning{if res,err:=dockerJSON(ctx,client,http.MethodPost,"/containers/"+url.PathEscape(oldID)+"/start",nil);err==nil{_ = expectDockerStatus(res,204,304)}}
 }
}

func deployBuiltImage(ctx context.Context,p deploymentExecutePayload,imageRef string)(deploymentExecuteResult,error){
 var out deploymentExecuteResult
 client,err:=deploymentHTTPClient(5*time.Minute);if err!=nil{return out,err};name:=*p.Runtime.ContainerName
 oldID,oldRunning,_,err:=inspectNamedContainer(ctx,client,name);if err!=nil{return out,err}
 backupName:=""
 if oldID!=""{
  if oldRunning{res,err:=dockerJSON(ctx,client,http.MethodPost,"/containers/"+url.PathEscape(oldID)+"/stop?t=15",nil);if err!=nil{return out,err};if err:=expectDockerStatus(res,204,304);err!=nil{return out,err}}
  backupName=name+"-clouddeck-prev-"+strings.ToLower(p.DeploymentID[:8]);if len(backupName)>127{backupName=backupName[:127]}
  res,err:=dockerJSON(ctx,client,http.MethodPost,"/containers/"+url.PathEscape(oldID)+"/rename?name="+url.QueryEscape(backupName),nil);if err!=nil{return out,err};if err:=expectDockerStatus(res,204);err!=nil{return out,err}
 }
 config:=map[string]any{"Image":imageRef,"HostConfig":map[string]any{"RestartPolicy":map[string]any{"Name":*p.Runtime.RestartPolicy}}}
 if p.Runtime.ContainerPort!=nil{
  key:=strconv.Itoa(*p.Runtime.ContainerPort)+"/tcp";config["ExposedPorts"]=map[string]any{key:map[string]any{}}
  if p.Runtime.HostPort!=nil{config["HostConfig"].(map[string]any)["PortBindings"]=map[string]any{key:[]map[string]string{{"HostPort":strconv.Itoa(*p.Runtime.HostPort)}}}}
 }
 encoded,_:=json.Marshal(config);res,err:=dockerJSON(ctx,client,http.MethodPost,"/containers/create?name="+url.QueryEscape(name),strings.NewReader(string(encoded)));if err!=nil{rollbackContainer(ctx,client,"",oldID,name,oldRunning);return out,err}
 if res.StatusCode<200||res.StatusCode>=300{_ = expectDockerStatus(res,201);rollbackContainer(ctx,client,"",oldID,name,oldRunning);return out,errors.New("Docker container create failed")}
 var created struct{ID string `json:"Id"`};decodeErr:=json.NewDecoder(io.LimitReader(res.Body,64<<10)).Decode(&created);res.Body.Close();if decodeErr!=nil||created.ID==""{rollbackContainer(ctx,client,"",oldID,name,oldRunning);return out,errors.New("Invalid Docker create response")}
 start,err:=dockerJSON(ctx,client,http.MethodPost,"/containers/"+url.PathEscape(created.ID)+"/start",nil);if err!=nil{rollbackContainer(ctx,client,created.ID,oldID,name,oldRunning);return out,err};if err:=expectDockerStatus(start,204,304);err!=nil{rollbackContainer(ctx,client,created.ID,oldID,name,oldRunning);return out,err}
 deadline:=time.Now().Add(30*time.Second)
 for {
  _,running,healthy,err:=inspectNamedContainer(ctx,client,created.ID);if err!=nil{rollbackContainer(ctx,client,created.ID,oldID,name,oldRunning);return out,err}
  if running&&healthy{break};if time.Now().After(deadline){rollbackContainer(ctx,client,created.ID,oldID,name,oldRunning);return out,errors.New("Container readiness check failed")}
  select{case <-ctx.Done():rollbackContainer(context.Background(),client,created.ID,oldID,name,oldRunning);return out,ctx.Err();case <-time.After(2*time.Second):}
 }
 out=deploymentExecuteResult{ContainerID:created.ID,ImageRef:imageRef};if oldID!=""{out.PreviousContainerID=&oldID};return out,nil
}

func executeDeploymentCommand(ctx context.Context,command agentCommand,write func(any)error){
 result:=commandResult{Type:"command.result",RequestID:command.RequestID}
 var p deploymentExecutePayload
 if command.Type!="command"||command.RequestID==""||decodeStrict(command.Payload,&p)!=nil||validateDeploymentPayload(p)!=nil{result.Error="Invalid deployment request";_ = write(result);return}
 emitDeploymentProgress(write,p.DeploymentID,"cloning","Downloading pinned GitHub source")
 root,err:=downloadDeploymentSource(ctx,p);if err!=nil{result.Error=err.Error();_ = write(result);return};defer os.RemoveAll(root)
 emitDeploymentProgress(write,p.DeploymentID,"building","Building Docker image through Docker Engine API")
 imageRef,err:=buildDeploymentImage(ctx,root,p);if err!=nil{result.Error=err.Error();_ = write(result);return}
 emitDeploymentProgress(write,p.DeploymentID,"deploying","Activating the built container")
 deployed,err:=deployBuiltImage(ctx,p,imageRef);if err!=nil{result.Error=err.Error();_ = write(result);return}
 emitDeploymentProgress(write,p.DeploymentID,"health-checking","Container started; readiness verified")
 result.Success=true;result.Data=deployed;_ = write(result)
}


type deploymentRollbackPayload struct {
 DeploymentID string `json:"deploymentId"`
 ContainerName string `json:"containerName"`
 CurrentContainerID string `json:"currentContainerId"`
 PreviousContainerID string `json:"previousContainerId"`
}
type deploymentRollbackResult struct {
 ContainerID string `json:"containerId"`
 RolledBackContainerID string `json:"rolledBackContainerId"`
}

func validateRollbackPayload(p deploymentRollbackPayload) error {
 if !deploymentUUID.MatchString(p.DeploymentID)||!composeName.MatchString(p.ContainerName){return errors.New("Invalid rollback identity")}
 if !dockerID.MatchString(p.CurrentContainerID)||!dockerID.MatchString(p.PreviousContainerID)||p.CurrentContainerID==p.PreviousContainerID{return errors.New("Invalid rollback container IDs")}
 return nil
}

func waitContainerReady(ctx context.Context,client *http.Client,id string,timeout time.Duration)error{
 deadline:=time.Now().Add(timeout)
 for{
  _,running,healthy,err:=inspectNamedContainer(ctx,client,id);if err!=nil{return err}
  if running&&healthy{return nil}
  if time.Now().After(deadline){return errors.New("Container readiness check failed")}
  select{case <-ctx.Done():return ctx.Err();case <-time.After(2*time.Second):}
 }
}

func rollbackDeploymentContainer(ctx context.Context,p deploymentRollbackPayload)(deploymentRollbackResult,error){
 var out deploymentRollbackResult
 client,err:=deploymentHTTPClient(5*time.Minute);if err!=nil{return out,err}
 activeID,activeRunning,_,err:=inspectNamedContainer(ctx,client,p.ContainerName);if err!=nil{return out,err}
 if activeID==""||activeID!=p.CurrentContainerID{return out,errors.New("Active deployment container no longer matches rollback target")}
 previousID,_,_,err:=inspectNamedContainer(ctx,client,p.PreviousContainerID);if err!=nil{return out,err}
 if previousID==""||previousID!=p.PreviousContainerID{return out,errors.New("Previous deployment container is unavailable")}
 if activeRunning{
  res,err:=dockerJSON(ctx,client,http.MethodPost,"/containers/"+url.PathEscape(activeID)+"/stop?t=15",nil);if err!=nil{return out,err}
  if err:=expectDockerStatus(res,204,304);err!=nil{return out,err}
 }
 rolledName:=p.ContainerName+"-clouddeck-rolled-"+strings.ToLower(p.DeploymentID[:8]);if len(rolledName)>127{rolledName=rolledName[:127]}
 res,err:=dockerJSON(ctx,client,http.MethodPost,"/containers/"+url.PathEscape(activeID)+"/rename?name="+url.QueryEscape(rolledName),nil);if err!=nil{return out,err}
 if err:=expectDockerStatus(res,204);err!=nil{return out,err}
 previousBackupName:=p.ContainerName+"-clouddeck-prev-"+strings.ToLower(p.DeploymentID[:8]);if len(previousBackupName)>127{previousBackupName=previousBackupName[:127]}
 restoreCurrent:=func(){
  if res,err:=dockerJSON(context.Background(),client,http.MethodPost,"/containers/"+url.PathEscape(previousID)+"/rename?name="+url.QueryEscape(previousBackupName),nil);err==nil{_ = expectDockerStatus(res,204)}
  if res,err:=dockerJSON(context.Background(),client,http.MethodPost,"/containers/"+url.PathEscape(activeID)+"/rename?name="+url.QueryEscape(p.ContainerName),nil);err==nil{_ = expectDockerStatus(res,204)}
  if activeRunning{if res,err:=dockerJSON(context.Background(),client,http.MethodPost,"/containers/"+url.PathEscape(activeID)+"/start",nil);err==nil{_ = expectDockerStatus(res,204,304)}}
 }
 res,err=dockerJSON(ctx,client,http.MethodPost,"/containers/"+url.PathEscape(previousID)+"/rename?name="+url.QueryEscape(p.ContainerName),nil);if err!=nil{restoreCurrent();return out,err}
 if err:=expectDockerStatus(res,204);err!=nil{restoreCurrent();return out,err}
 res,err=dockerJSON(ctx,client,http.MethodPost,"/containers/"+url.PathEscape(previousID)+"/start",nil);if err!=nil{restoreCurrent();return out,err}
 if err:=expectDockerStatus(res,204,304);err!=nil{restoreCurrent();return out,err}
 if err:=waitContainerReady(ctx,client,previousID,30*time.Second);err!=nil{
  if stop,stopErr:=dockerJSON(context.Background(),client,http.MethodPost,"/containers/"+url.PathEscape(previousID)+"/stop?t=10",nil);stopErr==nil{_ = expectDockerStatus(stop,204,304)}
  restoreCurrent();return out,err
 }
 return deploymentRollbackResult{ContainerID:previousID,RolledBackContainerID:activeID},nil
}

func executeDeploymentRollbackCommand(ctx context.Context,command agentCommand,write func(any)error){
 result:=commandResult{Type:"command.result",RequestID:command.RequestID}
 var p deploymentRollbackPayload
 if command.Type!="command"||command.RequestID==""||decodeStrict(command.Payload,&p)!=nil||validateRollbackPayload(p)!=nil{result.Error="Invalid deployment rollback request";_ = write(result);return}
 rolledBack,err:=rollbackDeploymentContainer(ctx,p);if err!=nil{result.Error=err.Error();_ = write(result);return}
 result.Success=true;result.Data=rolledBack;_ = write(result)
}
