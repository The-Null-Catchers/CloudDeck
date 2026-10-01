package main

import (
 "archive/tar"
 "compress/gzip"
 "context"
 "io"
 "strings"
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

func TestPostgresBackupUsesCredentialFileAndVerifiesDump(t *testing.T){
 target:=t.TempDir()
 tools:=t.TempDir()
 pgDump:=filepath.Join(tools,"pg_dump")
 pgRestore:=filepath.Join(tools,"pg_restore")
 dumpScript:="#!/bin/sh\ncase \"$*\" in *super-secret*) exit 41;; esac\n[ -f \"$PGPASSFILE\" ] || exit 42\ngrep -q 'super-secret' \"$PGPASSFILE\" || exit 43\nprintf 'PGDMP-fake-content'\n"
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
 assertDatabaseArchive(t,target,result,"database.dump")
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

func assertDatabaseArchive(t *testing.T,target string,result backupExecutionResult,dumpName string){
 t.Helper()
 file,err:=os.Open(filepath.Join(target,result.StorageKey))
 if err!=nil{t.Fatal(err)}
 defer file.Close()
 gz,err:=gzip.NewReader(file)
 if err!=nil{t.Fatal(err)}
 defer gz.Close()
 tr:=tar.NewReader(gz)
 files:=0
 for{
  header,err:=tr.Next()
  if err==io.EOF{break}
  if err!=nil{t.Fatal(err)}
  if header.Typeflag==tar.TypeDir{continue}
  files++
  if header.Name!="dump/"+dumpName{t.Fatalf("unexpected file in database archive: %s",header.Name)}
  data,err:=io.ReadAll(tr)
  if err!=nil{t.Fatal(err)}
  if strings.Contains(string(data),"super-secret"){t.Fatal("credential leaked into archive")}
 }
 if files!=1||result.EntryCount!=2{t.Fatalf("expected only directory and dump, got %d files and %d entries",files,result.EntryCount)}
 entries,err:=os.ReadDir(target)
 if err!=nil{t.Fatal(err)}
 if len(entries)!=1||entries[0].Name()!=result.StorageKey{t.Fatal("temporary credentials or dump were not cleaned up")}
}

func TestMysqlBackupExcludesCredentialsFromArchive(t *testing.T){
 target:=t.TempDir()
 binary:=filepath.Join(t.TempDir(),"mysqldump")
 script:=`#!/bin/sh
case "$1" in --defaults-extra-file=*) credentials="${1#*=}";; *) exit 41;; esac
[ -f "$credentials" ] || exit 42
grep -q 'super-secret' "$credentials" || exit 43
case "$*" in *super-secret*) exit 44;; esac
printf 'CREATE TABLE example (id INT);'
`
 if err:=os.WriteFile(binary,[]byte(script),0700);err!=nil{t.Fatal(err)}
 t.Setenv("CLOUDDECK_MYSQLDUMP_BIN",binary)
 t.Setenv("CLOUDDECK_BACKUP_DIR",target)
 result,err:=executeLocalBackup(context.Background(),backupExecutePayload{
  BackupID:"66666666-6666-4666-8666-666666666666",Kind:"mysql",Source:"appdb",TargetType:"local",
  Database:&databaseBackupConfig{Host:"db.internal",Port:3306,Username:"backup",Password:"super-secret",SSLMode:"require"},
 })
 if err!=nil{t.Fatal(err)}
 assertDatabaseArchive(t,target,result,"database.sql")
}

func TestDatabaseBackupFailureCleansCredentialsAndPartialDump(t *testing.T){
 target:=t.TempDir()
 binary:=filepath.Join(t.TempDir(),"pg_dump")
 if err:=os.WriteFile(binary,[]byte("#!/bin/sh\nprintf 'partial dump'\nexit 1\n"),0700);err!=nil{t.Fatal(err)}
 t.Setenv("CLOUDDECK_PG_DUMP_BIN",binary)
 t.Setenv("CLOUDDECK_BACKUP_DIR",target)
 _,err:=executeLocalBackup(context.Background(),backupExecutePayload{
  BackupID:"77777777-7777-4777-8777-777777777777",Kind:"postgres",Source:"appdb",TargetType:"local",
  Database:&databaseBackupConfig{Host:"db.internal",Port:5432,Username:"backup",Password:"super-secret",SSLMode:"require"},
 })
 if err==nil{t.Fatal("expected failed dump")}
 entries,err:=os.ReadDir(target)
 if err!=nil{t.Fatal(err)}
 if len(entries)!=0{t.Fatal("failed backup left credentials or dump behind")}
}

func TestDatabaseBackupRejectsOptionNamesAndCredentialLineBreaks(t *testing.T){
 config:=databaseBackupConfig{Host:"db.internal",Port:5432,Username:"backup",Password:"secret",SSLMode:"require"}
 for _,kind:=range []string{"postgres","mysql"}{
  if err:=validateDatabaseBackupConfig(kind,"--all-databases",&config);err==nil{t.Fatal("accepted option-shaped database name")}
  for _,password:=range []string{"secret\nextra","secret\rextra","secret\x00extra"}{
   current:=config
   current.Password=password
   if err:=validateDatabaseBackupConfig(kind,"appdb",&current);err==nil{t.Fatal("accepted credential control character")}
  }
 }
}
