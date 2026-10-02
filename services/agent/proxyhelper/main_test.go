package main

import (
 "context"
 "os"
 "path/filepath"
 "strings"
 "testing"
)

func writeExecutable(t *testing.T,path,body string){
 t.Helper()
 if err:=os.WriteFile(path,[]byte(body),0755);err!=nil{t.Fatal(err)}
}

func TestValidateRequestRejectsUnsafeProxyInput(t *testing.T){
 good:=requestBody{ProxyType:"caddy",Hostname:"api.example.com",TargetPort:4000}
 if err:=validateRequest(good,false);err!=nil{t.Fatal(err)}
 for _,body:=range []requestBody{
  {ProxyType:"caddy",Hostname:"../example.com",TargetPort:4000},
  {ProxyType:"apache",Hostname:"api.example.com",TargetPort:4000},
  {ProxyType:"nginx",Hostname:"api.example.com",TargetPort:0},
 }{
  if err:=validateRequest(body,false);err==nil{t.Fatalf("unsafe proxy input accepted: %+v",body)}
 }
}

func TestCaddyApplyWritesOnlyCloudDeckFragmentAndReloads(t *testing.T){
 root:=t.TempDir()
 dir:=filepath.Join(root,"clouddeck.d")
 if err:=os.MkdirAll(dir,0755);err!=nil{t.Fatal(err)}
 main:=filepath.Join(root,"Caddyfile")
 if err:=os.WriteFile(main,[]byte("import "+dir+"/*\n"),0644);err!=nil{t.Fatal(err)}
 caddy:=filepath.Join(root,"caddy")
 systemctl:=filepath.Join(root,"systemctl")
 marker:=filepath.Join(root,"reload")
 writeExecutable(t,caddy,"#!/bin/sh\n[ \"$1\" = validate ] || exit 31\nexit 0\n")
 writeExecutable(t,systemctl,"#!/bin/sh\n[ \"$1\" = reload ] || exit 32\ntouch '"+marker+"'\n")
 t.Setenv("CLOUDDECK_CADDY_DIR",dir)
 t.Setenv("CLOUDDECK_CADDYFILE",main)
 t.Setenv("CLOUDDECK_CADDY_BIN",caddy)
 t.Setenv("CLOUDDECK_SYSTEMCTL_BIN",systemctl)

 body:=requestBody{ProxyType:"caddy",Hostname:"api.example.com",TargetPort:4000}
 if err:=mutate(context.Background(),body,false);err!=nil{t.Fatal(err)}
 data,err:=os.ReadFile(filepath.Join(dir,"api.example.com.caddy"));if err!=nil{t.Fatal(err)}
 if string(data)!="api.example.com {\n\treverse_proxy 127.0.0.1:4000\n}\n"{t.Fatalf("unexpected Caddy fragment: %q",data)}
 if _,err:=os.Stat(marker);err!=nil{t.Fatal("Caddy reload was not requested")}
}

func TestCaddyValidationFailureRestoresPreviousFragment(t *testing.T){
 root:=t.TempDir()
 dir:=filepath.Join(root,"clouddeck.d")
 if err:=os.MkdirAll(dir,0755);err!=nil{t.Fatal(err)}
 main:=filepath.Join(root,"Caddyfile")
 if err:=os.WriteFile(main,[]byte("import "+dir+"/*\n"),0644);err!=nil{t.Fatal(err)}
 path:=filepath.Join(dir,"api.example.com.caddy")
 previous:=[]byte("api.example.com {\n\trespond \"old\"\n}\n")
 if err:=os.WriteFile(path,previous,0644);err!=nil{t.Fatal(err)}
 caddy:=filepath.Join(root,"caddy")
 systemctl:=filepath.Join(root,"systemctl")
 writeExecutable(t,caddy,"#!/bin/sh\nexit 9\n")
 writeExecutable(t,systemctl,"#!/bin/sh\nexit 0\n")
 t.Setenv("CLOUDDECK_CADDY_DIR",dir)
 t.Setenv("CLOUDDECK_CADDYFILE",main)
 t.Setenv("CLOUDDECK_CADDY_BIN",caddy)
 t.Setenv("CLOUDDECK_SYSTEMCTL_BIN",systemctl)

 err:=mutate(context.Background(),requestBody{ProxyType:"caddy",Hostname:"api.example.com",TargetPort:4000},false)
 if err==nil||!strings.Contains(err.Error(),"validation"){t.Fatalf("expected validation failure, got %v",err)}
 data,readErr:=os.ReadFile(path);if readErr!=nil{t.Fatal(readErr)}
 if string(data)!=string(previous){t.Fatalf("previous config was not restored: %q",data)}
}

func TestNginxRequiresGeneratedFileToBeIncluded(t *testing.T){
 root:=t.TempDir()
 dir:=filepath.Join(root,"conf.d")
 if err:=os.MkdirAll(dir,0755);err!=nil{t.Fatal(err)}
 nginx:=filepath.Join(root,"nginx")
 systemctl:=filepath.Join(root,"systemctl")
 expected:=filepath.Join(dir,"clouddeck-api.example.com.conf")
 script:="#!/bin/sh\nif [ \"$1\" = \"-t\" ]; then exit 0; fi\nif [ \"$1\" = \"-T\" ]; then echo '# configuration file "+expected+":'; exit 0; fi\nexit 10\n"
 writeExecutable(t,nginx,script)
 writeExecutable(t,systemctl,"#!/bin/sh\nexit 0\n")
 t.Setenv("CLOUDDECK_NGINX_DIR",dir)
 t.Setenv("CLOUDDECK_NGINX_BIN",nginx)
 t.Setenv("CLOUDDECK_SYSTEMCTL_BIN",systemctl)

 if err:=mutate(context.Background(),requestBody{ProxyType:"nginx",Hostname:"api.example.com",TargetPort:8080},false);err!=nil{t.Fatal(err)}
 data,err:=os.ReadFile(expected);if err!=nil{t.Fatal(err)}
 if !strings.Contains(string(data),"proxy_pass http://127.0.0.1:8080;"){t.Fatalf("unexpected Nginx config: %q",data)}
}
