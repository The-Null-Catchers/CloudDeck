package main

import (
 "errors"
 "os"
 "path/filepath"
 "strings"
)

// encryptLocalBackupAtRest atomically replaces a verified plaintext archive with
// the authenticated CloudDeck backup format when an encryption key is configured.
// The returned size is the size of the object that remains on disk.
func encryptLocalBackupAtRest(path string)(int64,error){
 key,configured,err:=backupEncryptionKey()
 if err!=nil{return 0,err}
 if !configured{
  stat,err:=os.Stat(path)
  if err!=nil{return 0,errors.New("backup archive is unavailable")}
  return stat.Size(),nil
 }
 dir:=filepath.Dir(path)
 staging,err:=os.CreateTemp(dir,".clouddeck-local-encrypted-*")
 if err!=nil{return 0,errors.New("unable to create encrypted local backup staging file")}
 encryptedPath:=staging.Name()
 if err:=staging.Close();err!=nil{_ = os.Remove(encryptedPath);return 0,errors.New("unable to prepare encrypted local backup staging file")}
 _=os.Remove(encryptedPath)
 ok:=false
 defer func(){if !ok{_ = os.Remove(encryptedPath)}}()
 if err:=encryptBackupPayload(path,encryptedPath,key);err!=nil{return 0,err}
 encrypted,err:=backupPayloadEncrypted(encryptedPath)
 if err!=nil||!encrypted{return 0,errors.New("encrypted local backup verification failed")}
 if err:=os.Rename(encryptedPath,path);err!=nil{return 0,errors.New("unable to activate encrypted local backup")}
 stat,err:=os.Stat(path)
 if err!=nil{return 0,errors.New("encrypted local backup is unavailable")}
 ok=true
 return stat.Size(),nil
}

// prepareBackupArchiveForRestore returns a plaintext archive path. Existing
// plaintext backups remain readable; encrypted local backups require the same
// master key and are decrypted into a short-lived 0600 staging file.
func prepareBackupArchiveForRestore(path,expectedSHA string)(string,func(),error){
 encrypted,err:=backupPayloadEncrypted(path)
 if err!=nil{return "",func(){},errors.New("unable to inspect backup encryption header")}
 if !encrypted{return path,func(){},nil}
 key,configured,keyErr:=backupEncryptionKey()
 if keyErr!=nil{return "",func(){},keyErr}
 if !configured{return "",func(){},errors.New("encrypted local backup requires CLOUDDECK_BACKUP_ENCRYPTION_KEY")}
 if !validBackupSHA(strings.ToLower(expectedSHA)){return "",func(){},errors.New("invalid backup checksum")}
 staging,err:=os.CreateTemp(filepath.Dir(path),".clouddeck-local-restore-*.tar.gz")
 if err!=nil{return "",func(){},errors.New("unable to create decrypted local restore staging file")}
 decryptedPath:=staging.Name()
 if err:=staging.Close();err!=nil{_ = os.Remove(decryptedPath);return "",func(){},errors.New("unable to prepare decrypted local restore staging file")}
 _=os.Remove(decryptedPath)
 cleanup:=func(){_ = os.Remove(decryptedPath)}
 if err:=decryptBackupPayload(path,decryptedPath,key);err!=nil{cleanup();return "",func(){},err}
 actual,err:=backupFileSHA256(decryptedPath)
 if err!=nil{cleanup();return "",func(){},errors.New("unable to verify decrypted local backup checksum")}
 if !strings.EqualFold(actual,expectedSHA){cleanup();return "",func(){},errors.New("decrypted local backup checksum mismatch")}
 return decryptedPath,cleanup,nil
}
