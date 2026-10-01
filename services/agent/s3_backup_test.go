package main

import (
 "context"
 "fmt"
 "io"
 "net/http"
 "net/http/httptest"
 "os"
 "path/filepath"
 "strings"
 "sync"
 "testing"
)

func TestS3BackupUploadsAndVerifiesBeforeSuccess(t *testing.T){
 sourceRoot:=t.TempDir()
 source:=filepath.Join(sourceRoot,"data")
 if err:=os.MkdirAll(source,0700);err!=nil{t.Fatal(err)}
 if err:=os.WriteFile(filepath.Join(source,"payload.txt"),[]byte("clouddeck-s3-backup"),0600);err!=nil{t.Fatal(err)}
 staging:=t.TempDir()
 t.Setenv("CLOUDDECK_BACKUP_SOURCE_ROOTS",sourceRoot)
 t.Setenv("CLOUDDECK_BACKUP_DIR",staging)

 var mu sync.Mutex
 var uploaded []byte
 var checksum string
 var putAuth string
 var gotPath string
 server:=httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter,r *http.Request){
  mu.Lock()
  defer mu.Unlock()
  gotPath=r.URL.EscapedPath()
  switch r.Method{
  case http.MethodPut:
   putAuth=r.Header.Get("Authorization")
   checksum=r.Header.Get("x-amz-meta-clouddeck-sha256")
   uploaded,_=io.ReadAll(r.Body)
   w.WriteHeader(http.StatusOK)
  case http.MethodHead:
   w.Header().Set("Content-Length",fmt.Sprintf("%d",len(uploaded)))
   w.Header().Set("x-amz-meta-clouddeck-sha256",checksum)
   w.WriteHeader(http.StatusOK)
  default:
   w.WriteHeader(http.StatusMethodNotAllowed)
  }
 }))
 defer server.Close()

 result,err:=executeBackup(context.Background(),backupExecutePayload{
  BackupID:"88888888-8888-4888-8888-888888888888",
  Kind:"directory",
  Source:source,
  TargetType:"s3",
  S3:&s3BackupConfig{
   Endpoint:server.URL,Region:"us-east-1",Bucket:"clouddeck-backups",
   AccessKey:"access-key",SecretKey:"secret-key",Prefix:"prod/api",
  },
 })
 if err!=nil{t.Fatal(err)}
 if !result.Verified{t.Fatal("S3 backup must be verified before success")}
 if result.StorageKey!="prod/api/88888888-8888-4888-8888-888888888888.tar.gz"{t.Fatalf("unexpected storage key %q",result.StorageKey)}
 if !strings.HasPrefix(putAuth,"AWS4-HMAC-SHA256 Credential=access-key/"){t.Fatalf("missing SigV4 authorization: %q",putAuth)}
 if checksum!=result.SHA256{t.Fatalf("metadata checksum %q differs from result %q",checksum,result.SHA256)}
 if gotPath!="/clouddeck-backups/prod/api/88888888-8888-4888-8888-888888888888.tar.gz"{t.Fatalf("unexpected object path %q",gotPath)}
 entries,err:=os.ReadDir(staging)
 if err!=nil{t.Fatal(err)}
 if len(entries)!=0{t.Fatal("S3 backup left a local staging archive")}
}

func TestS3BackupFailsWhenHeadVerificationDoesNotMatch(t *testing.T){
 sourceRoot:=t.TempDir()
 source:=filepath.Join(sourceRoot,"data")
 if err:=os.MkdirAll(source,0700);err!=nil{t.Fatal(err)}
 if err:=os.WriteFile(filepath.Join(source,"payload.txt"),[]byte("clouddeck"),0600);err!=nil{t.Fatal(err)}
 staging:=t.TempDir()
 t.Setenv("CLOUDDECK_BACKUP_SOURCE_ROOTS",sourceRoot)
 t.Setenv("CLOUDDECK_BACKUP_DIR",staging)

 var size int
 server:=httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter,r *http.Request){
  switch r.Method{
  case http.MethodPut:
   data,_:=io.ReadAll(r.Body);size=len(data);w.WriteHeader(http.StatusOK)
  case http.MethodHead:
   w.Header().Set("Content-Length",fmt.Sprintf("%d",size))
   w.Header().Set("x-amz-meta-clouddeck-sha256",strings.Repeat("0",64))
   w.WriteHeader(http.StatusOK)
  }
 }))
 defer server.Close()

 _,err:=executeBackup(context.Background(),backupExecutePayload{
  BackupID:"99999999-9999-4999-8999-999999999999",Kind:"directory",Source:source,TargetType:"s3",
  S3:&s3BackupConfig{Endpoint:server.URL,Region:"us-east-1",Bucket:"clouddeck-backups",AccessKey:"access",SecretKey:"secret"},
 })
 if err==nil||!strings.Contains(err.Error(),"checksum"){t.Fatalf("expected checksum verification failure, got %v",err)}
 entries,readErr:=os.ReadDir(staging)
 if readErr!=nil{t.Fatal(readErr)}
 if len(entries)!=0{t.Fatal("failed S3 verification left a staging archive")}
}

func TestDeleteS3BackupIsScopedToConfiguredPrefix(t *testing.T){
 deleted:=""
 server:=httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter,r *http.Request){
  if r.Method!=http.MethodDelete{w.WriteHeader(http.StatusMethodNotAllowed);return}
  deleted=r.URL.Path
  if !strings.HasPrefix(r.Header.Get("Authorization"),"AWS4-HMAC-SHA256 "){t.Error("delete request was not signed")}
  w.WriteHeader(http.StatusNoContent)
 }))
 defer server.Close()
 config:=s3BackupConfig{Endpoint:server.URL,Region:"us-east-1",Bucket:"clouddeck-backups",AccessKey:"access",SecretKey:"secret",Prefix:"prod"}
 if err:=deleteS3Backup(context.Background(),config,"prod/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.tar.gz");err!=nil{t.Fatal(err)}
 if deleted!="/clouddeck-backups/prod/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.tar.gz"{t.Fatalf("unexpected delete path %q",deleted)}
 if err:=deleteS3Backup(context.Background(),config,"other/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.tar.gz");err==nil{t.Fatal("expected deletion outside configured prefix to be rejected")}
}
