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

func TestDeleteLocalBackupAcceptsOnlyStorageKey(t *testing.T){
 target:=t.TempDir()
 t.Setenv("CLOUDDECK_BACKUP_DIR",target)
 good:="44444444-4444-4444-8444-444444444444.tar.gz"
 if err:=os.WriteFile(filepath.Join(target,good),[]byte("archive"),0600);err!=nil{t.Fatal(err)}
 if err:=deleteLocalBackup(good);err!=nil{t.Fatal(err)}
 if _,err:=os.Stat(filepath.Join(target,good));!os.IsNotExist(err){t.Fatalf("archive still exists or unexpected error: %v",err)}
 if err:=deleteLocalBackup("../etc/passwd");err==nil{t.Fatal("expected traversal-shaped key to be rejected")}
}

func TestPostgresBackupUsesEnvironmentPasswordAndVerifiesDump(t *testing.T){
 target:=t.TempDir()
 tools:=t.TempDir()
 pgDump:=filepath.Join(tools,"pg_dump")
 pgRestore:=filepath.Join(tools,"pg_restore")
 dumpScript:="#!/bin/sh\ncase \"$*\" in *super-secret*) exit 41;; esac\n[ \"$PGPASSWORD\" = \"super-secret\" ] || exit 42\nprintf 'PGDMP-fake-content'\n"
 restoreScript:="#!/bin/sh\n[ \"$1\" = \"--list\" ] || exit 43\n[ -s \"$2\" ] || exit 44\nexit 0\n"
 if err:=os.WriteFile(pgDump,[]byte(dumpScript),0700);err!=nil{t.Fatal(err)}
 if err:=os.WriteFile(pgRestore,[]byte(restoreScript),0700);err!=nil{t.Fatal(err)}
 t.Setenv("CLOUDDECK_BACKUP_DIR",target)
 t.Setenv("CLOUDDECK_PG_DUMP_BIN",pgDump)
 t.Setenv("CLOUDDECK_PG_RESTORE_BIN",pgRestore)
 t.Setenv("CLOUDDECK_BACKUP_MAX_BYTES","10485760")

 result,err:=executeLocalBackup(context.Background(),backupExecutePayload{
  BackupID:"55555555-5555-4555-8555-555555555555",
  Kind:"postgres",
  Source:"appdb",
  TargetType:"local",
  Database:&databaseBackupConfig{
   Host:"db.internal",Port:5432,Username:"backup",Password:"super-secret",SSLMode:"require",
  },
 })
 if err!=nil{t.Fatal(err)}
 if !result.Verified{t.Fatal("database backup must be verified")}
 if result.EntryCount<2{t.Fatalf("expected staged directory and dump file, got %d entries",result.EntryCount)}
}

func TestDatabaseBackupValidationRejectsUnsafeConnectionFields(t *testing.T){
 cases:=[]databaseBackupConfig{
  {Host:"db.internal;touch /tmp/pwn",Port:5432,Username:"backup",Password:"secret",SSLMode:"require"},
  {Host:"db.internal",Port:0,Username:"backup",Password:"secret",SSLMode:"require"},
  {Host:"db.internal",Port:5432,Username:"bad user",Password:"secret",SSLMode:"require"},
  {Host:"db.internal",Port:5432,Username:"backup",Password:"secret",SSLMode:"invalid"},
 }
 for _,config:=range cases{
  current:=config
  if err:=validateDatabaseBackupConfig("postgres","appdb",&current);err==nil{t.Fatalf("expected invalid database config to be rejected: %+v",config)}
 }
 if err:=validateDatabaseBackupConfig("postgres","app db",&databaseBackupConfig{Host:"db.internal",Port:5432,Username:"backup",Password:"secret",SSLMode:"require"});err==nil{
  t.Fatal("expected unsafe database name to be rejected")
 }
}
