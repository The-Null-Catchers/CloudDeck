package main

import (
 "os"
 "path/filepath"
 "reflect"
 "testing"
)

func writeComposeFixture(t *testing.T,contents string)string{
 t.Helper()
 dir:=t.TempDir()
 path:=filepath.Join(dir,"compose.yml")
 if err:=os.WriteFile(path,[]byte(contents),0600);err!=nil{t.Fatal(err)}
 return path
}

func TestParseComposeSpecAndDependencyOrder(t *testing.T){
 path:=writeComposeFixture(t,`
services:
  db:
    image: postgres:17-alpine
    environment:
      POSTGRES_DB: app
  api:
    build: .
    restart: unless-stopped
    depends_on:
      - db
    ports:
      - "8080:4000"
`)
 spec,err:=parseComposeSpec(path);if err!=nil{t.Fatalf("parse failed: %v",err)}
 order,err:=composeStartOrder(spec.Services);if err!=nil{t.Fatal(err)}
 if !reflect.DeepEqual(order,[]string{"db","api"}){t.Fatalf("unexpected order: %#v",order)}
}

func TestParseComposeSpecRejectsDependencyCycles(t *testing.T){
 path:=writeComposeFixture(t,`
services:
  api:
    image: example/api
    depends_on: [worker]
  worker:
    image: example/worker
    depends_on: [api]
`)
 if _,err:=parseComposeSpec(path);err==nil{t.Fatal("expected cycle to be rejected")}
}

func TestParseComposeSpecRejectsUnsafeUnsupportedFeatures(t *testing.T){
 fixtures:=[]string{
`services:
  api:
    image: example/api
    privileged: true
`,
`services:
  api:
    image: example/api
    volumes:
      - /etc:/host
`,
`services:
  api:
    image: example/api
    command: ["sh","-c","echo hi"]
`,
`services:
  api:
    image: example/api
    network_mode: host
`,
 }
 for i,fixture:=range fixtures{
  if _,err:=parseComposeSpec(writeComposeFixture(t,fixture));err==nil{t.Fatalf("fixture %d should fail",i)}
 }
}

func TestComposePortBindings(t *testing.T){
 exposed,bindings,err:=composePortBindings([]string{"8080:80","53/udp"})
 if err!=nil{t.Fatal(err)}
 if _,ok:=exposed["80/tcp"];!ok{t.Fatal("expected tcp exposed port")}
 if _,ok:=exposed["53/udp"];!ok{t.Fatal("expected udp exposed port")}
 if _,ok:=bindings["80/tcp"];!ok{t.Fatal("expected host binding")}
}
