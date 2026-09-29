package main

import (
 "bufio"
 "context"
 "encoding/binary"
 "errors"
 "fmt"
 "io"
 "net"
 "net/http"
 "os"
 "os/exec"
 "strconv"
 "strings"
)

type streamSubscribe struct {
 Type string `json:"type"`
 SubscriptionID string `json:"subscriptionId"`
 Source string `json:"source"`
 Target string `json:"target"`
 Tail int `json:"tail"`
}
type streamUnsubscribe struct {
 Type string `json:"type"`
 SubscriptionID string `json:"subscriptionId"`
}

func emitStream(emit func(any) error,id,line,errText string,done bool) error {
 message:=map[string]any{"type":"stream.data","subscriptionId":id}
 if line!=""{message["line"]=line}
 if errText!=""{message["error"]=errText}
 if done{message["done"]=true}
 return emit(message)
}

func streamDockerLogs(ctx context.Context,id string,tail int,emit func(any) error,subscriptionID string) error {
 if !dockerID.MatchString(id){return errors.New("invalid container ID")}
 socket:=os.Getenv("CLOUDDECK_DOCKER_SOCKET")
 if socket==""||!strings.HasPrefix(socket,"/"){return errors.New("Docker integration disabled")}
 transport:=&http.Transport{DisableKeepAlives:true,DialContext:func(ctx context.Context,_,_ string)(net.Conn,error){var d net.Dialer;return d.DialContext(ctx,"unix",socket)}}
 client:=&http.Client{Transport:transport}
 req,err:=http.NewRequestWithContext(ctx,http.MethodGet,fmt.Sprintf("http://docker/containers/%s/logs?stdout=1&stderr=1&timestamps=1&follow=1&tail=%d",id,tail),nil)
 if err!=nil{return err}
 res,err:=client.Do(req);if err!=nil{return errors.New("Docker log stream unavailable")}
 defer res.Body.Close()
 if res.StatusCode<200||res.StatusCode>=300{return fmt.Errorf("Docker Engine returned HTTP %d",res.StatusCode)}
 header:=make([]byte,8)
 for {
  if _,err:=io.ReadFull(res.Body,header);err!=nil{
   if ctx.Err()!=nil{return nil}
   if errors.Is(err,io.EOF)||errors.Is(err,io.ErrUnexpectedEOF){return nil}
   return errors.New("Docker log stream interrupted")
  }
  size:=binary.BigEndian.Uint32(header[4:8])
  if size>64*1024{return errors.New("Docker log frame too large")}
  payload:=make([]byte,size)
  if _,err:=io.ReadFull(res.Body,payload);err!=nil{return errors.New("Docker log stream interrupted")}
  for _,line:=range strings.Split(strings.TrimSpace(string(payload)),"\n"){
   if line==""{continue};if len(line)>4000{line=line[:4000]}
   if err:=emitStream(emit,subscriptionID,line,"",false);err!=nil{return err}
  }
 }
}

func streamSystemdLogs(ctx context.Context,service string,tail int,emit func(any) error,subscriptionID string) error {
 if !systemdServiceName.MatchString(service){return errors.New("invalid service name")}
 command:=exec.CommandContext(ctx,"journalctl","-u",service,"-n",strconv.Itoa(tail),"-f","--no-pager","--output=short-iso")
 stdout,err:=command.StdoutPipe();if err!=nil{return errors.New("journal unavailable")}
 command.Stderr=io.Discard
 if err:=command.Start();err!=nil{return errors.New("journal unavailable")}
 scanner:=bufio.NewScanner(stdout);scanner.Buffer(make([]byte,4096),4096)
 for scanner.Scan(){
  line:=scanner.Text();if len(line)>4000{line=line[:4000]}
  if err:=emitStream(emit,subscriptionID,line,"",false);err!=nil{_ = command.Process.Kill();return err}
 }
 err=command.Wait()
 if ctx.Err()!=nil{return nil}
 if err!=nil{return errors.New("journal stream interrupted")}
 return scanner.Err()
}

func runLogStream(ctx context.Context,sub streamSubscribe,emit func(any) error) {
 var err error
 switch sub.Source{
 case "docker":err=streamDockerLogs(ctx,sub.Target,sub.Tail,emit,sub.SubscriptionID)
 case "systemd":err=streamSystemdLogs(ctx,sub.Target,sub.Tail,emit,sub.SubscriptionID)
 default:err=errors.New("unsupported log source")
 }
 if err!=nil{_ = emitStream(emit,sub.SubscriptionID,"",err.Error(),true);return}
 _ = emitStream(emit,sub.SubscriptionID,"","",true)
}
