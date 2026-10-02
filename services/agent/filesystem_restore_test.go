package main

import (
 "context"
 "net"
 "net/http"
 "os"
 "path/filepath"
 "strings"
 "testing"
)

func TestDirectoryRestoreReplacesContentsFromVerifiedBackup(t *testing.T){
 root:=t.TempDir()
 source:=filepath.Join(root,"app-data")
 if err:=os.MkdirAll(filepath.Join(source,"nested"),0700);err!=nil{t.Fatal(err)}
 if err:=os.WriteFile(filepath.Join(source,"nested","value.txt"),[]byte("before"),0600);err!=nil{t.Fatal(err)}
 backupDir:=t.TempDir()
 t.Setenv("CLOUDDECK_BACKUP_SOURCE_ROOTS",root)
 t.Setenv("CLOUDDECK_BACKUP_DIR",backupDir)

 backup,err:=executeBackup(context.Background(),backupExecutePayload{
  BackupID:"10101010-1010-4010-8010-101010101010",
  Kind:"directory",Source:source,TargetType:"local",
 })
 if err!=nil{t.Fatal(err)}
 if err:=os.WriteFile(filepath.Join(source,"nested","value.txt"),[]byte("after"),0600);err!=nil{t.Fatal(err)}
 if err:=os.WriteFile(filepath.Join(source,"extra.txt"),[]byte("remove-me"),0600);err!=nil{t.Fatal(err)}

 err=restoreFilesystem(context.Background(),filesystemRestorePayload{
  BackupID:"10101010-1010-4010-8010-101010101010",
  Kind:"directory",Source:source,TargetType:"local",
  StorageKey:backup.StorageKey,ExpectedSHA256:backup.SHA256,
 })
 if err!=nil{t.Fatal(err)}
 data,err:=os.ReadFile(filepath.Join(source,"nested","value.txt"));if err!=nil{t.Fatal(err)}
 if string(data)!="before"{t.Fatalf("restored value = %q, want before",data)}
 if _,err:=os.Stat(filepath.Join(source,"extra.txt"));!os.IsNotExist(err){t.Fatalf("extra file survived restore: %v",err)}
}

func TestDirectoryRestoreChecksumFailureDoesNotMutateTarget(t *testing.T){
 root:=t.TempDir()
 source:=filepath.Join(root,"data")
 if err:=os.MkdirAll(source,0700);err!=nil{t.Fatal(err)}
 if err:=os.WriteFile(filepath.Join(source,"value.txt"),[]byte("original"),0600);err!=nil{t.Fatal(err)}
 backupDir:=t.TempDir()
 t.Setenv("CLOUDDECK_BACKUP_SOURCE_ROOTS",root)
 t.Setenv("CLOUDDECK_BACKUP_DIR",backupDir)
 backup,err:=executeBackup(context.Background(),backupExecutePayload{
  BackupID:"20202020-2020-4020-8020-202020202020",Kind:"directory",Source:source,TargetType:"local",
 })
 if err!=nil{t.Fatal(err)}
 if err:=os.WriteFile(filepath.Join(source,"value.txt"),[]byte("current"),0600);err!=nil{t.Fatal(err)}

 err=restoreFilesystem(context.Background(),filesystemRestorePayload{
  BackupID:"20202020-2020-4020-8020-202020202020",Kind:"directory",Source:source,TargetType:"local",
  StorageKey:backup.StorageKey,ExpectedSHA256:strings.Repeat("0",64),
 })
 if err==nil||!strings.Contains(err.Error(),"checksum"){t.Fatalf("expected checksum failure, got %v",err)}
 data,readErr:=os.ReadFile(filepath.Join(source,"value.txt"));if readErr!=nil{t.Fatal(readErr)}
 if string(data)!="current"{t.Fatalf("target mutated on failed verification: %q",data)}
}

func TestDockerVolumeRestoreRequiresUnusedVolume(t *testing.T){
 socket:=filepath.Join(t.TempDir(),"docker.sock")
 listener,err:=net.Listen("unix",socket);if err!=nil{t.Fatal(err)}
 mux:=http.NewServeMux()
 mux.HandleFunc("/containers/json",func(w http.ResponseWriter,r *http.Request){
  w.Header().Set("Content-Type","application/json")
  _,_=w.Write([]byte(`[{"Mounts":[{"Type":"volume","Name":"app-data"}]}]`))
 })
 server:=&http.Server{Handler:mux};go server.Serve(listener);defer server.Close()
 t.Setenv("CLOUDDECK_DOCKER_SOCKET",socket)
 inUse,err:=dockerVolumeInUse("app-data")
 if err!=nil{t.Fatal(err)}
 if !inUse{t.Fatal("expected Docker volume to be detected as in use")}
}

func TestReplaceDirectoryRollsBackWhenActivationFails(t *testing.T){
 parent:=t.TempDir()
 target:=filepath.Join(parent,"data")
 if err:=os.Mkdir(target,0700);err!=nil{t.Fatal(err)}
 if err:=os.WriteFile(filepath.Join(target,"value"),[]byte("current"),0600);err!=nil{t.Fatal(err)}
 missingStage:=filepath.Join(parent,"missing-stage")
 err:=replaceDirectoryWithRollback(target,missingStage,"30303030-3030-4030-8030-303030303030")
 if err==nil{t.Fatal("expected activation failure")}
 data,readErr:=os.ReadFile(filepath.Join(target,"value"));if readErr!=nil{t.Fatal(readErr)}
 if string(data)!="current"{t.Fatalf("rollback did not restore original target: %q",data)}
}
