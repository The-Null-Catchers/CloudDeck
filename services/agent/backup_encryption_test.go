package main

import (
 "bytes"
 "encoding/base64"
 "os"
 "path/filepath"
 "testing"
)

func testEncryptionKey()[]byte{return bytes.Repeat([]byte{0x42},32)}

func TestBackupEncryptionRoundTrip(t *testing.T){
 dir:=t.TempDir()
 source:=filepath.Join(dir,"source.tar.gz")
 encrypted:=filepath.Join(dir,"encrypted.bin")
 restored:=filepath.Join(dir,"restored.tar.gz")
 payload:=bytes.Repeat([]byte("clouddeck-backup-payload\n"),90_000)
 if err:=os.WriteFile(source,payload,0600);err!=nil{t.Fatal(err)}
 if err:=encryptBackupPayload(source,encrypted,testEncryptionKey());err!=nil{t.Fatal(err)}
 isEncrypted,err:=backupPayloadEncrypted(encrypted)
 if err!=nil{t.Fatal(err)}
 if !isEncrypted{t.Fatal("expected encrypted payload marker")}
 if err:=decryptBackupPayload(encrypted,restored,testEncryptionKey());err!=nil{t.Fatal(err)}
 actual,err:=os.ReadFile(restored)
 if err!=nil{t.Fatal(err)}
 if !bytes.Equal(actual,payload){t.Fatal("decrypted payload mismatch")}
}

func TestBackupEncryptionRejectsTampering(t *testing.T){
 dir:=t.TempDir()
 source:=filepath.Join(dir,"source.tar.gz")
 encrypted:=filepath.Join(dir,"encrypted.bin")
 restored:=filepath.Join(dir,"restored.tar.gz")
 if err:=os.WriteFile(source,bytes.Repeat([]byte("sensitive"),1000),0600);err!=nil{t.Fatal(err)}
 if err:=encryptBackupPayload(source,encrypted,testEncryptionKey());err!=nil{t.Fatal(err)}
 data,err:=os.ReadFile(encrypted)
 if err!=nil{t.Fatal(err)}
 data[len(data)-20]^=0x01
 if err:=os.WriteFile(encrypted,data,0600);err!=nil{t.Fatal(err)}
 if err:=decryptBackupPayload(encrypted,restored,testEncryptionKey());err==nil{t.Fatal("expected authentication failure")}
 if _,err:=os.Stat(restored);!os.IsNotExist(err){t.Fatal("failed decrypt must remove partial plaintext")}
}

func TestBackupEncryptionRejectsTruncation(t *testing.T){
 dir:=t.TempDir()
 source:=filepath.Join(dir,"source.tar.gz")
 encrypted:=filepath.Join(dir,"encrypted.bin")
 restored:=filepath.Join(dir,"restored.tar.gz")
 if err:=os.WriteFile(source,bytes.Repeat([]byte("payload"),1000),0600);err!=nil{t.Fatal(err)}
 if err:=encryptBackupPayload(source,encrypted,testEncryptionKey());err!=nil{t.Fatal(err)}
 data,err:=os.ReadFile(encrypted)
 if err!=nil{t.Fatal(err)}
 if err:=os.WriteFile(encrypted,data[:len(data)-8],0600);err!=nil{t.Fatal(err)}
 if err:=decryptBackupPayload(encrypted,restored,testEncryptionKey());err==nil{t.Fatal("expected truncation failure")}
}

func TestBackupEncryptionKeyEnvironment(t *testing.T){
 t.Setenv("CLOUDDECK_BACKUP_ENCRYPTION_KEY",base64.StdEncoding.EncodeToString(testEncryptionKey()))
 key,configured,err:=backupEncryptionKey()
 if err!=nil{t.Fatal(err)}
 if !configured||!bytes.Equal(key,testEncryptionKey()){t.Fatal("expected configured encryption key")}
 t.Setenv("CLOUDDECK_BACKUP_ENCRYPTION_KEY","not-base64")
 if _,_,err:=backupEncryptionKey();err==nil{t.Fatal("expected invalid key error")}
}
