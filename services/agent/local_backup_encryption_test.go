package main

import (
 "bytes"
 "encoding/base64"
 "os"
 "path/filepath"
 "testing"
)

func TestLocalBackupAtRestRoundTrip(t *testing.T){
 dir:=t.TempDir()
 archive:=filepath.Join(dir,"backup.tar.gz")
 plaintext:=bytes.Repeat([]byte("local-backup-data\n"),50_000)
 if err:=os.WriteFile(archive,plaintext,0600);err!=nil{t.Fatal(err)}
 sha,err:=backupFileSHA256(archive)
 if err!=nil{t.Fatal(err)}
 t.Setenv("CLOUDDECK_BACKUP_ENCRYPTION_KEY",base64.StdEncoding.EncodeToString(testEncryptionKey()))
 size,err:=encryptLocalBackupAtRest(archive)
 if err!=nil{t.Fatal(err)}
 if size<=int64(len(plaintext)){t.Fatal("expected authenticated encryption overhead")}
 encrypted,err:=backupPayloadEncrypted(archive)
 if err!=nil{t.Fatal(err)}
 if !encrypted{t.Fatal("expected local backup to be encrypted at rest")}
 prepared,cleanup,err:=prepareBackupArchiveForRestore(archive,sha)
 if err!=nil{t.Fatal(err)}
 defer cleanup()
 recovered,err:=os.ReadFile(prepared)
 if err!=nil{t.Fatal(err)}
 if !bytes.Equal(recovered,plaintext){t.Fatal("local decrypted backup mismatch")}
}

func TestLocalEncryptedBackupRequiresKey(t *testing.T){
 dir:=t.TempDir()
 archive:=filepath.Join(dir,"backup.tar.gz")
 plaintext:=[]byte("sensitive local backup")
 if err:=os.WriteFile(archive,plaintext,0600);err!=nil{t.Fatal(err)}
 sha,err:=backupFileSHA256(archive)
 if err!=nil{t.Fatal(err)}
 t.Setenv("CLOUDDECK_BACKUP_ENCRYPTION_KEY",base64.StdEncoding.EncodeToString(testEncryptionKey()))
 if _,err:=encryptLocalBackupAtRest(archive);err!=nil{t.Fatal(err)}
 t.Setenv("CLOUDDECK_BACKUP_ENCRYPTION_KEY","")
 if _,_,err:=prepareBackupArchiveForRestore(archive,sha);err==nil{t.Fatal("expected encrypted local restore to require a key")}
}

func TestPlaintextLocalBackupRemainsCompatible(t *testing.T){
 dir:=t.TempDir()
 archive:=filepath.Join(dir,"legacy.tar.gz")
 if err:=os.WriteFile(archive,[]byte("legacy"),0600);err!=nil{t.Fatal(err)}
 prepared,cleanup,err:=prepareBackupArchiveForRestore(archive,"ignored-for-plaintext")
 if err!=nil{t.Fatal(err)}
 defer cleanup()
 if prepared!=archive{t.Fatal("plaintext backup should not be staged or rewritten")}
}
