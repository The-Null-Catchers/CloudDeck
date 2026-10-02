package main

import (
 "bytes"
 "context"
 "encoding/json"
 "errors"
 "io"
 "net"
 "net/http"
 "os"
 "path/filepath"
 "regexp"
 "strings"
 "time"
)

var proxyHostname=regexp.MustCompile(`^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$`)

type proxyCommandPayload struct{
 ProxyType string `json:"proxyType"`
 Hostname string `json:"hostname"`
 TargetPort int `json:"targetPort,omitempty"`
}

func validateProxyPayload(payload proxyCommandPayload,remove bool)error{
 if payload.ProxyType!="caddy"&&payload.ProxyType!="nginx"{return errors.New("unsupported proxy type")}
 if len(payload.Hostname)>253||!proxyHostname.MatchString(payload.Hostname){return errors.New("invalid proxy hostname")}
 if remove{
  if payload.TargetPort!=0{return errors.New("proxy remove must not include target port")}
 }else if payload.TargetPort<1||payload.TargetPort>65535{return errors.New("invalid proxy target port")}
 return nil
}

func proxyHelperClient()(*http.Client,string,error){
 socket:=strings.TrimSpace(os.Getenv("CLOUDDECK_PROXY_HELPER_SOCKET"))
 if socket==""{socket="/run/clouddeck-proxy-helper/helper.sock"}
 if !filepath.IsAbs(socket){return nil,"",errors.New("proxy helper socket path must be absolute")}
 transport:=&http.Transport{
  DisableKeepAlives:true,
  DialContext:func(ctx context.Context,_,_ string)(net.Conn,error){
   var dialer net.Dialer
   return dialer.DialContext(ctx,"unix",socket)
  },
 }
 return &http.Client{Transport:transport,Timeout:35*time.Second},"http://proxy-helper",nil
}

func callProxyHelper(ctx context.Context,path string,payload proxyCommandPayload)error{
 client,base,err:=proxyHelperClient();if err!=nil{return err}
 body,err:=json.Marshal(payload);if err!=nil{return errors.New("unable to encode proxy helper request")}
 request,err:=http.NewRequestWithContext(ctx,http.MethodPost,base+path,bytes.NewReader(body));if err!=nil{return errors.New("unable to prepare proxy helper request")}
 request.Header.Set("Content-Type","application/json")
 response,err:=client.Do(request);if err!=nil{return errors.New("proxy helper unavailable")}
 defer response.Body.Close()
 data,readErr:=io.ReadAll(io.LimitReader(response.Body,4096))
 if readErr!=nil{return errors.New("unable to read proxy helper response")}
 if response.StatusCode<200||response.StatusCode>=300{
  var failure struct{Error string `json:"error"`}
  _=json.Unmarshal(data,&failure)
  message:=strings.TrimSpace(failure.Error);if message==""{message="proxy helper rejected request"}
  if len(message)>500{message=message[:500]}
  return errors.New(message)
 }
 var result struct{OK bool `json:"ok"`}
 if err:=json.Unmarshal(data,&result);err!=nil||!result.OK{return errors.New("invalid proxy helper response")}
 return nil
}

func executeProxyCommand(ctx context.Context,command agentCommand)commandResult{
 result:=commandResult{Type:"command.result",RequestID:command.RequestID}
 if command.Type!="command"||command.RequestID==""{result.Error="Invalid proxy command";return result}
 remove:=false
 endpoint:=""
 switch command.Action{
 case "proxy.applyDomain":endpoint="/v1/apply"
 case "proxy.removeDomain":endpoint="/v1/remove";remove=true
 default:result.Error="Action not allowed";return result
 }
 var payload proxyCommandPayload
 if err:=decodeStrict(command.Payload,&payload);err!=nil||validateProxyPayload(payload,remove)!=nil{result.Error="Invalid proxy payload";return result}
 if err:=callProxyHelper(ctx,endpoint,payload);err!=nil{result.Error=err.Error();return result}
 result.Success=true
 result.Data=map[string]bool{"ok":true}
 return result
}
