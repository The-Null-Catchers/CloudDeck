package main

import (
 "context"
 "os"
 "path/filepath"
 "testing"
)

func TestDirectoryBackupCreatesVerifiedArchive(t *testing.T){
 sourceRoot:=t.TempDir()
 source:=filepath.Join(sourceRoot,"app-data")
 if err:=os.MkdirAll(filepath.Join(source,"nested"),0700);err!=nil{t.Fatal(err)}
 if err:=os.WriteFile(filepath.Join(source,"nested","data.txt"),[]byte("clouddeck-backup"),0600);err!=nil{t.Fatal(err)}
 target:=t.TempDir()
 t.Setenv("CLOUDDECK_BACKUP_SOURCE_ROOTS",sourceRoot)
 t.Setenv("CLOUDDECK_BACKUP_DIR",target)
 t.Setenv("CLOUDDECK_BACKUP_MAX_BYTES","10485760")

 result,err:=executeLocalBackup(context.Background(),backupExecutePayload{
  BackupID:"11111111-1111-4111-8111-111111111111",
  Kind:"directory",
  Source:source,
  TargetType:"local",
 })
 if err!=nil{t.Fatal(err)}
 if !result.Verified{t.Fatal("backup must be verified before success")}
 if result.EntryCount<3{t.Fatalf("expected directory and file entries, got %d",result.EntryCount)}
 if len(result.SHA256)!=64{t.Fatalf("unexpected sha256 length: %d",len(result.SHA256))}
 info,err:=os.Stat(filepath.Join(target,result.StorageKey))
 if err!=nil{t.Fatal(err)}
 if info.Mode().Perm()!=0600{t.Fatalf("backup archive permissions = %o, want 600",info.Mode().Perm())}
 if info.Size()!=result.SizeBytes{t.Fatalf("reported size %d differs from file size %d",result.SizeBytes,info.Size())}
}

func TestDirectoryBackupRejectsSourceOutsideAllowlist(t *testing.T){
 allowed:=t.TempDir()
 outside:=t.TempDir()
 t.Setenv("CLOUDDECK_BACKUP_SOURCE_ROOTS",allowed)
 t.Setenv("CLOUDDECK_BACKUP_DIR",t.TempDir())

 _,err:=executeLocalBackup(context.Background(),backupExecutePayload{
  BackupID:"22222222-2222-4222-8222-222222222222",
  Kind:"directory",
  Source:outside,
  TargetType:"local",
 })
 if err==nil{t.Fatal("expected outside allowlist source to be rejected")}
}

func TestDirectoryBackupRejectsSymlinks(t *testing.T){
 root:=t.TempDir()
 source:=filepath.Join(root,"data")
 if err:=os.MkdirAll(source,0700);err!=nil{t.Fatal(err)}
 if err:=os.Symlink("/etc/passwd",filepath.Join(source,"passwd-link"));err!=nil{t.Fatal(err)}
 t.Setenv("CLOUDDECK_BACKUP_SOURCE_ROOTS",root)
 t.Setenv("CLOUDDECK_BACKUP_DIR",t.TempDir())

 _,err:=executeLocalBackup(context.Background(),backupExecutePayload{
  BackupID:"33333333-3333-4333-8333-333333333333",
  Kind:"directory",
  Source:source,
  TargetType:"local",
 })
 if err==nil{t.Fatal("expected symlink backup to be rejected")}
}
