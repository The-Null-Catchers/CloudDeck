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
 "runtime"
 "strconv"
 "strings"
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
type credentials struct { ServerID string `json:"serverId"`; Credential string `json:"credential"` }
func readConfig(path string) (credentials,error) { var c credentials; b,e:=os.ReadFile(path);if e!=nil{return c,e};e=json.Unmarshal(b,&c);return c,e }
func saveConfig(path string,c credentials) error { b,e:=json.Marshal(c);if e!=nil{return e};return os.WriteFile(path,b,0600) }
func pair(base,id,token string) (string,error) {
 payload,_:=json.Marshal(map[string]string{"serverId":id,"token":token})
 response,e:=http.Post(base+"/api/v1/agent/pair","application/json",bytes.NewReader(payload));if e!=nil{return "",e};defer response.Body.Close()
 if response.StatusCode!=201{return "",fmt.Errorf("pairing failed (HTTP %d)",response.StatusCode)}
 var result struct{Credential string `json:"credential"`};e=json.NewDecoder(io.LimitReader(response.Body,4096)).Decode(&result);return result.Credential,e
}
func main(){
 base:=strings.TrimRight(os.Getenv("CLOUDDECK_API_URL"),"/"); id:=os.Getenv("CLOUDDECK_SERVER_ID"); path:=os.Getenv("CLOUDDECK_CREDENTIAL_FILE");if path==""{path="/var/lib/clouddeck-agent/credential.json"}
 if base=="" || id=="" {log.Fatal("CLOUDDECK_API_URL and CLOUDDECK_SERVER_ID are required")}
 u,e:=url.Parse(base);if e!=nil || (u.Scheme!="https" && !(u.Scheme=="http" && (u.Hostname()=="localhost" || u.Hostname()=="127.0.0.1"))){log.Fatal("HTTPS is required outside localhost")}
 c,e:=readConfig(path)
 if errors.Is(e,os.ErrNotExist){token:=os.Getenv("CLOUDDECK_PAIRING_TOKEN");if token==""{log.Fatal("pairing token required for first connection")};credential,err:=pair(base,id,token);if err!=nil{log.Fatal(err)};c=credentials{ServerID:id,Credential:credential};if err=saveConfig(path,c);err!=nil{log.Fatal(err)}}else if e!=nil{log.Fatal(e)}
 if c.ServerID!=id{log.Fatal("credential belongs to a different server")}
 ws:=*u;if u.Scheme=="https"{ws.Scheme="wss"}else{ws.Scheme="ws"};ws.Path="/api/v1/agent/connect/"+url.PathEscape(id)
 for {if err:=connect(ws.String(),c.Credential);err!=nil{log.Printf("connection interrupted: %v",err)};time.Sleep(5*time.Second)}
}
func connect(endpoint,credential string) error {
 header:=http.Header{};header.Set("Authorization","Bearer "+credential)
 conn,_,err:=websocket.DefaultDialer.Dial(endpoint,header);if err!=nil{return err};defer conn.Close()
 host,_:=os.Hostname();if err=conn.WriteJSON(map[string]string{"type":"hello","hostname":host,"operatingSystem":runtime.GOOS,"architecture":runtime.GOARCH,"agentVersion":"0.1.0"});err!=nil{return err}
 ctx,cancel:=context.WithCancel(context.Background());defer cancel()
 go func(){defer cancel();for {_,_,err:=conn.ReadMessage();if err!=nil{return}}}()
 ticker:=time.NewTicker(15*time.Second);defer ticker.Stop()
 var previousCPU,totalCPU uint64
 for {select {case <-ctx.Done():return errors.New("socket closed");case <-ticker.C:
  m:=collect(&previousCPU,&totalCPU);if err:=conn.WriteJSON(m);err!=nil{return err}
 }}
}
func collect(previousIdle,previousTotal *uint64) metric {
 m:=metric{Type:"metrics"}
 if b,e:=os.ReadFile("/proc/stat");e==nil {line:=strings.SplitN(string(b),"\n",2)[0];fields:=strings.Fields(line);var total,idle uint64;for i,v:=range fields[1:]{n,_:=strconv.ParseUint(v,10,64);total+=n;if i==3 || i==4{idle+=n}};if total>*previousTotal{delta:=total-*previousTotal;if delta>0{m.CPUPercent=100*float64(delta-(idle-*previousIdle))/float64(delta)}};*previousTotal=total;*previousIdle=idle}
 if b,e:=os.ReadFile("/proc/meminfo");e==nil {var total,available float64;for _,line:=range strings.Split(string(b),"\n"){fields:=strings.Fields(line);if len(fields)<2{continue};n,_:=strconv.ParseFloat(fields[1],64);switch fields[0]{case "MemTotal:":total=n;case "MemAvailable:":available=n}};if total>0{m.MemoryPercent=100*(total-available)/total}}
 if b,e:=os.ReadFile("/proc/loadavg");e==nil {m.Load1,_=strconv.ParseFloat(strings.Fields(string(b))[0],64)}
 if b,e:=os.ReadFile("/proc/net/dev");e==nil {for _,line:=range strings.Split(string(b),"\n"){parts:=strings.SplitN(line,":",2);if len(parts)<2 || strings.TrimSpace(parts[0])=="lo"{continue};fields:=strings.Fields(parts[1]);if len(fields)>=9{rx,_:=strconv.ParseUint(fields[0],10,64);tx,_:=strconv.ParseUint(fields[8],10,64);m.NetworkRxBytes+=rx;m.NetworkTxBytes+=tx}}}
 m.DiskPercent=diskUsage("/")
 return m
}
