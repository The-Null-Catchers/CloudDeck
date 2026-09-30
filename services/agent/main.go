package main

import (
 "bytes"
 "context"
 "encoding/json"
 "errors"
 "fmt"
 "io"
 "log"
 "net/http"
 "net/url"
 "os"
 "path/filepath"
 "runtime"
 "strconv"
 "strings"
 "sync"
 "time"

 "github.com/gorilla/websocket"
)

type metric struct {
 Type string `json:"type"`
 CPUPercent float64 `json:"cpuPercent"`
 MemoryPercent float64 `json:"memoryPercent"`
 DiskPercent float64 `json:"diskPercent"`
 Load1 float64 `json:"load1"`
 NetworkRxBytes uint64 `json:"networkRxBytes"`
 NetworkTxBytes uint64 `json:"networkTxBytes"`
}

type credentials struct {
 ServerID string `json:"serverId"`
 Credential string `json:"credential"`
}

func readConfig(path string) (credentials,error) {
 var c credentials
 info,err:=os.Stat(path)
 if err!=nil {return c,err}
 if info.Mode().Perm()&0077!=0 {return c,errors.New("credential file permissions are too broad")}
 contents,err:=os.ReadFile(path)
 if err!=nil {return c,err}
 err=json.Unmarshal(contents,&c)
 return c,err
}

func saveConfig(path string,c credentials) error {
 if err:=os.MkdirAll(filepath.Dir(path),0700);err!=nil{return err}
 contents,err:=json.Marshal(c)
 if err!=nil{return err}
 file,err:=os.OpenFile(path,os.O_WRONLY|os.O_CREATE|os.O_EXCL,0600)
 if err!=nil{return err}
 defer file.Close()
 if _,err=file.Write(contents);err!=nil {os.Remove(path);return err}
 return file.Sync()
}

func pair(base,id,token string) (string,error) {
 payload,_:=json.Marshal(map[string]string{"serverId":id,"token":token})
 client:=&http.Client{Timeout:10*time.Second}
 response,err:=client.Post(base+"/api/v1/agent/pair","application/json",bytes.NewReader(payload))
 if err!=nil{return "",err}
 defer response.Body.Close()
 if response.StatusCode!=http.StatusCreated{return "",fmt.Errorf("pairing failed (HTTP %d)",response.StatusCode)}
 var result struct{Credential string `json:"credential"`}
 if err=json.NewDecoder(io.LimitReader(response.Body,4096)).Decode(&result);err!=nil{return "",err}
 if result.Credential==""{return "",errors.New("pairing response has no credential")}
 return result.Credential,nil
}

func main() {
 base:=strings.TrimRight(os.Getenv("CLOUDDECK_API_URL"),"/")
 id:=os.Getenv("CLOUDDECK_SERVER_ID")
 path:=os.Getenv("CLOUDDECK_CREDENTIAL_FILE")
 if path=="" {path="/var/lib/clouddeck-agent/credential.json"}
 if base=="" || id=="" {log.Fatal("CLOUDDECK_API_URL and CLOUDDECK_SERVER_ID are required")}
 endpoint,err:=url.Parse(base)
 if err!=nil || (endpoint.Scheme!="https" && !(endpoint.Scheme=="http" && (endpoint.Hostname()=="localhost" || endpoint.Hostname()=="127.0.0.1"))) {
  log.Fatal("HTTPS is required outside localhost")
 }
 c,err:=readConfig(path)
 if errors.Is(err,os.ErrNotExist) {
  token:=os.Getenv("CLOUDDECK_PAIRING_TOKEN")
  if token==""{log.Fatal("pairing token required for first connection")}
  credential,pairErr:=pair(base,id,token)
  if pairErr!=nil{log.Fatal(pairErr)}
  c=credentials{ServerID:id,Credential:credential}
  if err=saveConfig(path,c);err!=nil{log.Fatal(err)}
 } else if err!=nil {log.Fatal(err)}
 if c.ServerID!=id || c.Credential==""{log.Fatal("credential belongs to a different server or is missing")}
 if len(os.Args)==2 && os.Args[1]=="--pair-only" {return}
 if len(os.Args)>1 {log.Fatal("unsupported argument")}
 ws:=*endpoint
 if endpoint.Scheme=="https"{ws.Scheme="wss"}else{ws.Scheme="ws"}
 ws.Path="/api/v1/agent/connect/"+url.PathEscape(id)
 for {
  if err:=connect(ws.String(),c.Credential);err!=nil{log.Printf("connection interrupted: %v",err)}
  time.Sleep(5*time.Second)
 }
}

func connect(endpoint,credential string) error {
 headers:=http.Header{}
 headers.Set("Authorization","Bearer "+credential)
 conn,_,err:=websocket.DefaultDialer.Dial(endpoint,headers)
 if err!=nil{return err}
 defer conn.Close()
 var writeMu sync.Mutex
 write:=func(value any) error {writeMu.Lock();defer writeMu.Unlock();return conn.WriteJSON(value)}
 conn.SetReadLimit(8192)
 host,_:=os.Hostname()
 if err=write(map[string]string{"type":"hello","hostname":host,"operatingSystem":runtime.GOOS,"architecture":runtime.GOARCH,"agentVersion":"0.2.0"});err!=nil{return err}
 ctx,cancel:=context.WithCancel(context.Background())
 defer cancel()
 terminals:=newTerminalManager(ctx,write)
 defer terminals.closeAll()
 subscriptions:=map[string]context.CancelFunc{}
 var subscriptionsMu sync.Mutex
 go func() {
  defer cancel()
  defer func(){subscriptionsMu.Lock();for _,stop:=range subscriptions{stop()};subscriptionsMu.Unlock()}()
  for {
   _,message,err:=conn.ReadMessage()
   if err!=nil{return}
   var envelope struct{Type string `json:"type"`}
   if json.Unmarshal(message,&envelope)!=nil{continue}
   switch envelope.Type{
   case "command":
    var command agentCommand
    if json.Unmarshal(message,&command)!=nil{continue}
    if command.Action=="deployment.execute"{
     go executeDeploymentCommand(ctx,command,write)
     continue
    }
    if command.Action=="deployment.rollback"{
     go executeDeploymentRollbackCommand(ctx,command,write)
     continue
    }
    if command.Action=="deployment.rollbackCompose"{
     go executeComposeRollbackCommand(ctx,command,write)
     continue
    }
    if command.Action=="deployment.cancel"{
     go executeDeploymentCancelCommand(command,write)
     continue
    }
    if write(executeCommand(command))!=nil{return}
   case "stream.subscribe":
    var sub streamSubscribe
    if json.Unmarshal(message,&sub)!=nil || sub.SubscriptionID=="" || sub.Tail<0 || sub.Tail>500{continue}
    subscriptionsMu.Lock()
    if old:=subscriptions[sub.SubscriptionID];old!=nil{old()}
    streamCtx,stop:=context.WithCancel(ctx);subscriptions[sub.SubscriptionID]=stop
    subscriptionsMu.Unlock()
    go func(){
     runLogStream(streamCtx,sub,write)
     subscriptionsMu.Lock();delete(subscriptions,sub.SubscriptionID);subscriptionsMu.Unlock()
    }()
   case "stream.unsubscribe":
    var unsub streamUnsubscribe
    if json.Unmarshal(message,&unsub)!=nil || unsub.SubscriptionID==""{continue}
    subscriptionsMu.Lock();stop:=subscriptions[unsub.SubscriptionID];delete(subscriptions,unsub.SubscriptionID);subscriptionsMu.Unlock()
    if stop!=nil{stop()}
   case "terminal.open":
    var request terminalOpen
    if json.Unmarshal(message,&request)!=nil{continue}
    if err:=terminals.open(request);err!=nil{_ = write(map[string]any{"type":"terminal.exit","sessionId":request.SessionID,"error":err.Error()})}
   case "terminal.input":
    var request terminalInput
    if json.Unmarshal(message,&request)!=nil{continue}
    if err:=terminals.input(request);err!=nil{_ = write(map[string]any{"type":"terminal.exit","sessionId":request.SessionID,"error":err.Error()});terminals.close(request.SessionID)}
   case "terminal.resize":
    var request terminalResize
    if json.Unmarshal(message,&request)!=nil{continue}
    if err:=terminals.resize(request);err!=nil{_ = write(map[string]any{"type":"terminal.exit","sessionId":request.SessionID,"error":err.Error()});terminals.close(request.SessionID)}
   case "terminal.close":
    var request terminalClose
    if json.Unmarshal(message,&request)!=nil || !terminalSessionID.MatchString(request.SessionID){continue}
    terminals.close(request.SessionID)
   }
  }
 }()
 ticker:=time.NewTicker(15*time.Second)
 defer ticker.Stop()
 var previousIdle,previousTotal uint64
 for {
  select {
  case <-ctx.Done():return errors.New("socket closed")
  case <-ticker.C:
   if err:=write(collect(&previousIdle,&previousTotal));err!=nil{return err}
  }
 }
}

func collect(previousIdle,previousTotal *uint64) metric {
 result:=metric{Type:"metrics"}
 if contents,err:=os.ReadFile("/proc/stat");err==nil {
  fields:=strings.Fields(strings.SplitN(string(contents),"\n",2)[0])
  var total,idle uint64
  if len(fields)<5{return result}
  for i,value:=range fields[1:] {
   count,_:=strconv.ParseUint(value,10,64)
   total+=count
   if i==3 || i==4 {idle+=count}
  }
  if total>*previousTotal && idle>=*previousIdle {
   delta:=total-*previousTotal
   idleDelta:=idle-*previousIdle
   if idleDelta<=delta {result.CPUPercent=100*float64(delta-idleDelta)/float64(delta)}
  }
  *previousTotal=total
  *previousIdle=idle
 }
 if contents,err:=os.ReadFile("/proc/meminfo");err==nil {
  var total,available float64
  for _,line:=range strings.Split(string(contents),"\n") {
   fields:=strings.Fields(line)
   if len(fields)<2{continue}
   count,_:=strconv.ParseFloat(fields[1],64)
   switch fields[0]{case "MemTotal:":total=count;case "MemAvailable:":available=count}
  }
  if total>0 {result.MemoryPercent=100*(total-available)/total}
 }
 if contents,err:=os.ReadFile("/proc/loadavg");err==nil {
  fields:=strings.Fields(string(contents))
  if len(fields)>0 {result.Load1,_=strconv.ParseFloat(fields[0],64)}
 }
 if contents,err:=os.ReadFile("/proc/net/dev");err==nil {
  for _,line:=range strings.Split(string(contents),"\n") {
   parts:=strings.SplitN(line,":",2)
   if len(parts)<2 || strings.TrimSpace(parts[0])=="lo"{continue}
   fields:=strings.Fields(parts[1])
   if len(fields)>=9 {
    rx,_:=strconv.ParseUint(fields[0],10,64)
    tx,_:=strconv.ParseUint(fields[8],10,64)
    result.NetworkRxBytes+=rx
    result.NetworkTxBytes+=tx
   }
  }
 }
 result.DiskPercent=diskUsage("/")
 return result
}
