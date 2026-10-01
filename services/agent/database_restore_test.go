package main

import (
 "archive/tar"
 "compress/gzip"
 "context"
 "crypto/sha256"
 "encoding/hex"
 "io"
 "os"
 "path/filepath"
 "strings"
 "testing"
)

func writeRestoreArchive(t *testing.T,root,id,kind string)(string,string){
 t.Helper()
 key:=id+".tar.gz"
 path:=filepath.Join(root,key)
 file,err:=os.OpenFile(path,os.O_WRONLY|os.O_CREATE|os.O_EXCL,0600);if err!=nil{t.Fatal(err)}
 hash:=sha256.New();gz:=gzip.NewWriter(io.MultiWriter(file,hash));tw:=tar.NewWriter(gz)
 if err:=tw.WriteHeader(&tar.Header{Name:"dump/",Mode:0700,Typeflag:tar.TypeDir});err!=nil{t.Fatal(err)}
 name:="dump/database.dump";body:=[]byte("PGDMP-restore-content")
 if kind=="mysql"{name="dump/database.sql";body=[]byte("CREATE TABLE restored (id INT);")}
 if err:=tw.WriteHeader(&tar.Header{Name:name,Mode:0600,Typeflag:tar.TypeReg,Size:int64(len(body))});err!=nil{t.Fatal(err)}
 if _,err:=tw.Write(body);err!=nil{t.Fatal(err)}
 if err:=tw.Close();err!=nil{t.Fatal(err)};if err:=gz.Close();err!=nil{t.Fatal(err)};if err:=file.Sync();err!=nil{t.Fatal(err)};if err:=file.Close();err!=nil{t.Fatal(err)}
 return key,hex.EncodeToString(hash.Sum(nil))
}

func TestPostgresRestoreUsesCredentialFileAndFixedTooling(t *testing.T){
 root:=t.TempDir();t.Setenv("CLOUDDECK_BACKUP_DIR",root)
 id:="aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";key,sha:=writeRestoreArchive(t,root,id,"postgres")
 tools:=t.TempDir();marker:=filepath.Join(tools,"restored");script:=filepath.Join(tools,"pg_restore")
 body:="#!/bin/sh\ncase \"$*\" in *super-secret*) exit 41;; esac\n[ -f \"$PGPASSFILE\" ] || exit 42\ngrep -q 'super-secret' \"$PGPASSFILE\" || exit 43\ncase \"$*\" in *--clean*--if-exists*--exit-on-error*) ;; *) exit 44;; esac\ntouch '"+marker+"'\n"
 if err:=os.WriteFile(script,[]byte(body),0700);err!=nil{t.Fatal(err)};t.Setenv("CLOUDDECK_PG_RESTORE_BIN",script)
 err:=restoreDatabase(context.Background(),databaseRestorePayload{BackupID:id,Kind:"postgres",DatabaseName:"appdb",TargetType:"local",StorageKey:key,ExpectedSHA256:sha,Database:&databaseBackupConfig{Host:"db.internal",Port:5432,Username:"backup",Password:"super-secret",SSLMode:"require"}})
 if err!=nil{t.Fatal(err)};if _,err:=os.Stat(marker);err!=nil{t.Fatalf("restore tool did not run: %v",err)}
}

func TestMysqlRestoreStreamsDumpThroughClientWithoutPasswordArgument(t *testing.T){
 root:=t.TempDir();t.Setenv("CLOUDDECK_BACKUP_DIR",root)
 id:="11111111-2222-4333-8444-555555555555";key,sha:=writeRestoreArchive(t,root,id,"mysql")
 tools:=t.TempDir();marker:=filepath.Join(tools,"mysql-restored");script:=filepath.Join(tools,"mysql")
 body:="#!/bin/sh\ncase \"$*\" in *super-secret*) exit 41;; esac\ncase \"$1\" in --defaults-extra-file=*) credentials=\"${1#*=}\";; *) exit 42;; esac\ngrep -q 'super-secret' \"$credentials\" || exit 43\ngrep -q 'CREATE TABLE restored' || exit 44\ntouch '"+marker+"'\n"
 if err:=os.WriteFile(script,[]byte(body),0700);err!=nil{t.Fatal(err)};t.Setenv("CLOUDDECK_MYSQL_BIN",script)
 err:=restoreDatabase(context.Background(),databaseRestorePayload{BackupID:id,Kind:"mysql",DatabaseName:"appdb",TargetType:"local",StorageKey:key,ExpectedSHA256:sha,Database:&databaseBackupConfig{Host:"db.internal",Port:3306,Username:"backup",Password:"super-secret",SSLMode:"require"}})
 if err!=nil{t.Fatal(err)};if _,err:=os.Stat(marker);err!=nil{t.Fatalf("restore tool did not run: %v",err)}
}

func TestDatabaseRestoreRejectsChecksumMismatchAndUnsafeStorageKey(t *testing.T){
 root:=t.TempDir();t.Setenv("CLOUDDECK_BACKUP_DIR",root)
 id:="66666666-7777-4888-8999-aaaaaaaaaaaa";key,_:=writeRestoreArchive(t,root,id,"postgres")
 config:=&databaseBackupConfig{Host:"db.internal",Port:5432,Username:"backup",Password:"secret",SSLMode:"require"}
 payload:=databaseRestorePayload{BackupID:id,Kind:"postgres",DatabaseName:"appdb",TargetType:"local",StorageKey:key,ExpectedSHA256:strings.Repeat("0",64),Database:config}
 if err:=restoreDatabase(context.Background(),payload);err==nil||!strings.Contains(err.Error(),"checksum"){t.Fatalf("expected checksum rejection, got %v",err)}
 payload.StorageKey="../"+key;if _,_,err:=restoreArchivePath(context.Background(),payload);err==nil{t.Fatal("expected path-shaped storage key to be rejected")}
}
