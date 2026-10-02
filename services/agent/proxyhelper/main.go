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
 "os/exec"
 "os/user"
 "path/filepath"
 "regexp"
 "strconv"
 "strings"
 "time"
)

type requestBody struct {
 ProxyType string `json:"proxyType"`
 Hostname string `json:"hostname"`
 TargetPort int `json:"targetPort,omitempty"`
}

var hostnamePattern=regexp.MustCompile(`^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$`)

func env(name,fallback string)string{
 value:=strings.TrimSpace(os.Getenv(name));if value==""{return fallback};return value
}
func executable(name,fallback string)(string,error){
 path:=env(name,fallback)
 if !filepath.IsAbs(path){return "",errors.New("helper executable path must be absolute")}
 info,err:=os.Stat(path);if err!=nil||info.IsDir()||info.Mode()&0111==0{return "",errors.New("required proxy tooling is unavailable")}
 return path,nil
}
func validateRequest(body requestBody,remove bool)error{
 if body.ProxyType!="caddy"&&body.ProxyType!="nginx"{return errors.New("unsupported proxy type")}
 if len(body.Hostname)>253||!hostnamePattern.MatchString(body.Hostname){return errors.New("invalid hostname")}
 if remove{
  if body.TargetPort!=0{return errors.New("remove request must not include a target port")}
 }else if body.TargetPort<1||body.TargetPort>65535{return errors.New("invalid target port")}
 return nil
}
func configPath(proxyType,hostname string)string{
 if proxyType=="caddy"{return filepath.Join(env("CLOUDDECK_CADDY_DIR","/etc/caddy/clouddeck.d"),hostname+".caddy")}
 return filepath.Join(env("CLOUDDECK_NGINX_DIR","/etc/nginx/conf.d"),"clouddeck-"+hostname+".conf")
}
func render(body requestBody)[]byte{
 if body.ProxyType=="caddy"{
  return []byte(fmt.Sprintf("%s {\n\treverse_proxy 127.0.0.1:%d\n}\n",body.Hostname,body.TargetPort))
 }
 return []byte(fmt.Sprintf(`server {
    listen 80;
    listen [::]:80;
    server_name %s;

    location / {
        proxy_pass http://127.0.0.1:%d;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
`,body.Hostname,body.TargetPort))
}
func atomicWrite(path string,data []byte)error{
 dir:=filepath.Dir(path)
 if err:=os.MkdirAll(dir,0755);err!=nil{return errors.New("unable to create proxy config directory")}
 file,err:=os.CreateTemp(dir,".clouddeck-proxy-*");if err!=nil{return errors.New("unable to create proxy config")}
 temp:=file.Name();ok:=false
 defer func(){_ = file.Close();if !ok{_ = os.Remove(temp)}}()
 if err:=file.Chmod(0644);err!=nil{return errors.New("unable to secure proxy config")}
 if _,err:=file.Write(data);err!=nil{return errors.New("unable to write proxy config")}
 if err:=file.Sync();err!=nil{return errors.New("unable to sync proxy config")}
 if err:=file.Close();err!=nil{return errors.New("unable to close proxy config")}
 if err:=os.Rename(temp,path);err!=nil{return errors.New("unable to activate proxy config")}
 ok=true
 return nil
}
func snapshot(path string)([]byte,bool,error){
 data,err:=os.ReadFile(path)
 if errors.Is(err,os.ErrNotExist){return nil,false,nil}
 if err!=nil{return nil,false,errors.New("unable to read existing proxy config")}
 return data,true,nil
}
func restoreSnapshot(path string,data []byte,existed bool){
 if existed{_ = atomicWrite(path,data)}else{_ = os.Remove(path)}
}
func runBounded(ctx context.Context,binary string,args ...string)(string,error){
 command:=exec.CommandContext(ctx,binary,args...)
 output,err:=command.CombinedOutput()
 if len(output)>256*1024{output=output[:256*1024]}
 if err!=nil{
  message:=strings.TrimSpace(string(output));if len(message)>500{message=message[:500]}
  if message==""{message=err.Error()}
  return message,errors.New(message)
 }
 return string(output),nil
}
func validateCaddy(ctx context.Context,path string)error{
 main:=env("CLOUDDECK_CADDYFILE","/etc/caddy/Caddyfile")
 contents,err:=os.ReadFile(main);if err!=nil{return errors.New("unable to read Caddyfile")}
 expected:="import "+filepath.Join(filepath.Dir(path),"*")
 if !strings.Contains(string(contents),expected){return fmt.Errorf("Caddyfile must contain %q",expected)}
 binary,err:=executable("CLOUDDECK_CADDY_BIN","/usr/bin/caddy");if err!=nil{return err}
 _,runErr:=runBounded(ctx,binary,"validate","--config",main,"--adapter","caddyfile")
 if runErr!=nil{return errors.New("Caddy validation failed: "+runErr.Error())}
 return nil
}
func validateNginx(ctx context.Context,path string)error{
 binary,err:=executable("CLOUDDECK_NGINX_BIN","/usr/sbin/nginx");if err!=nil{return err}
 if _,runErr:=runBounded(ctx,binary,"-t");runErr!=nil{return errors.New("Nginx validation failed: "+runErr.Error())}
 output,runErr:=runBounded(ctx,binary,"-T")
 if runErr!=nil{return errors.New("Nginx config inspection failed: "+runErr.Error())}
 marker:="# configuration file "+path+":"
 if !strings.Contains(output,marker){return errors.New("Nginx active configuration does not include the CloudDeck conf.d file")}
 return nil
}
func reload(ctx context.Context,proxyType string)error{
 binary,err:=executable("CLOUDDECK_SYSTEMCTL_BIN","/usr/bin/systemctl");if err!=nil{return err}
 service:=proxyType
 if _,runErr:=runBounded(ctx,binary,"reload",service);runErr!=nil{return fmt.Errorf("%s reload failed: %w",proxyType,runErr)}
 return nil
}
func validate(ctx context.Context,proxyType,path string)error{
 if proxyType=="caddy"{return validateCaddy(ctx,path)}
 return validateNginx(ctx,path)
}
func mutate(ctx context.Context,body requestBody,remove bool)error{
 if err:=validateRequest(body,remove);err!=nil{return err}
 path:=configPath(body.ProxyType,body.Hostname)
 previous,existed,err:=snapshot(path);if err!=nil{return err}
 if remove{
  if err:=os.Remove(path);err!=nil&&!errors.Is(err,os.ErrNotExist){return errors.New("unable to remove proxy config")}
 }else if err:=atomicWrite(path,render(body));err!=nil{return err}
 if err:=validate(ctx,body.ProxyType,path);err!=nil{
  restoreSnapshot(path,previous,existed)
  return err
 }
 if err:=reload(ctx,body.ProxyType);err!=nil{
  restoreSnapshot(path,previous,existed)
  _=reload(context.Background(),body.ProxyType)
  return err
 }
 return nil
}
func decode(r *http.Request)(requestBody,error){
 var body requestBody
 decoder:=json.NewDecoder(io.LimitReader(r.Body,4097));decoder.DisallowUnknownFields()
 if err:=decoder.Decode(&body);err!=nil{return body,errors.New("invalid request")}
 var extra any
 if decoder.Decode(&extra)!=io.EOF{return body,errors.New("invalid request")}
 return body,nil
}
func handler(remove bool)http.HandlerFunc{
 return func(w http.ResponseWriter,r *http.Request){
  w.Header().Set("Content-Type","application/json")
  if r.Method!=http.MethodPost{w.WriteHeader(http.StatusMethodNotAllowed);_,_=w.Write([]byte(`{"error":"method not allowed"}`));return}
  body,err:=decode(r);if err==nil{
   ctx,cancel:=context.WithTimeout(r.Context(),30*time.Second);defer cancel()
   err=mutate(ctx,body,remove)
  }
  if err!=nil{w.WriteHeader(http.StatusBadRequest);_ = json.NewEncoder(w).Encode(map[string]string{"error":err.Error()});return}
  _ = json.NewEncoder(w).Encode(map[string]bool{"ok":true})
 }
}
func main(){
 if os.Geteuid()!=0{fmt.Fprintln(os.Stderr,"clouddeck-proxy-helper must run as root");os.Exit(1)}
 socket:=env("CLOUDDECK_PROXY_HELPER_SOCKET","/run/clouddeck-proxy-helper/helper.sock")
 if !filepath.IsAbs(socket){fmt.Fprintln(os.Stderr,"helper socket must be absolute");os.Exit(1)}
 if info,err:=os.Lstat(socket);err==nil{
  if info.Mode()&os.ModeSocket==0{fmt.Fprintln(os.Stderr,"helper socket path is not a socket");os.Exit(1)}
  _=os.Remove(socket)
 }
 if err:=os.MkdirAll(filepath.Dir(socket),0755);err!=nil{fmt.Fprintln(os.Stderr,err);os.Exit(1)}
 listener,err:=net.Listen("unix",socket);if err!=nil{fmt.Fprintln(os.Stderr,err);os.Exit(1)}
 defer listener.Close()
 group,err:=user.LookupGroup("clouddeck");if err!=nil{fmt.Fprintln(os.Stderr,"clouddeck group not found");os.Exit(1)}
 gid,err:=strconv.Atoi(group.Gid);if err!=nil{fmt.Fprintln(os.Stderr,"invalid clouddeck group");os.Exit(1)}
 if err:=os.Chown(socket,0,gid);err!=nil{fmt.Fprintln(os.Stderr,err);os.Exit(1)}
 if err:=os.Chmod(socket,0660);err!=nil{fmt.Fprintln(os.Stderr,err);os.Exit(1)}
 mux:=http.NewServeMux()
 mux.HandleFunc("/v1/apply",handler(false))
 mux.HandleFunc("/v1/remove",handler(true))
 server:=&http.Server{Handler:mux,ReadHeaderTimeout:5*time.Second,ReadTimeout:35*time.Second,WriteTimeout:35*time.Second,IdleTimeout:30*time.Second}
 if err:=server.Serve(listener);err!=nil&&err!=http.ErrServerClosed{fmt.Fprintln(os.Stderr,err);os.Exit(1)}
}
