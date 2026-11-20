package main

import (
 "errors"
 "os"
 "path/filepath"
 "strings"
)

// encryptLocalBackupAtRest atomically replaces a verified plaintext archive with
// an authenticated format-2 backup. New backups fail closed when no key is configured.
func encryptLocalBackupAtRest(path string)(int64,error){
 key,configured,err:=backupEncryptionKey()
 if err!=nil{return 0,err}
 if !configured{return 0,errors.New("backup encryption is required; configure CLOUDDECK_BACKUP_ENCRYPTION_KEY on the agent")}
 keyVersion,err:=backupEncryptionKeyVersion()
 if err!=nil{return 0,err}
 expectedSHA,err:=backupFileSHA256(path)
 if err!=nil{return 0,errors.New("unable to checksum plaintext backup before encryption")}
 dir:=filepath.Dir(path)
 staging,err:=os.CreateTemp(dir,".clouddeck-local-encrypted-*")
 if err!=nil{return 0,errors.New("unable to create encrypted local backup staging file")}
 encryptedPath:=staging.Name()
 if err:=staging.Close();err!=nil{_ = os.Remove(encryptedPath);return 0,errors.New("unable to prepare encrypted local backup staging file")}
 _=os.Remove(encryptedPath)
 ok:=false
 defer func(){if !ok{_ = os.Remove(encryptedPath)}}()
 if err:=encryptBackupPayload(path,encryptedPath,key);err!=nil{return 0,err}
 header,encrypted,err:=readBackupEncryptionHeader(encryptedPath)
 if err!=nil||!encrypted||header.FormatVersion!=2||header.KeyVersion!=keyVersion{return 0,errors.New("encrypted local backup header verification failed")}

 verifyFile,err:=os.CreateTemp(dir,".clouddeck-local-verify-*")
 if err!=nil{return 0,errors.New("unable to create local backup verification staging file")}
 verifyPath:=verifyFile.Name()
 if err:=verifyFile.Close();err!=nil{_ = os.Remove(verifyPath);return 0,errors.New("unable to prepare local backup verification staging file")}
 _=os.Remove(verifyPath)
 defer os.Remove(verifyPath)
 if err:=decryptBackupPayload(encryptedPath,verifyPath,key);err!=nil{return 0,errors.New("encrypted local backup authentication verification failed")}
 verifiedSHA,err:=backupFileSHA256(verifyPath)
 if err!=nil||!strings.EqualFold(verifiedSHA,expectedSHA){return 0,errors.New("encrypted local backup plaintext checksum verification failed")}

 if err:=os.Rename(encryptedPath,path);err!=nil{return 0,errors.New("unable to activate encrypted local backup")}
 stat,err:=os.Stat(path)
 if err!=nil{return 0,errors.New("encrypted local backup is unavailable")}
 ok=true
 return stat.Size(),nil
}

// prepareBackupArchiveForRestore returns a plaintext archive path. Existing
// plaintext backups remain readable; encrypted backups use their recorded key version.
func prepareBackupArchiveForRestore(path,expectedSHA string)(string,func(),error){
 encrypted,err:=backupPayloadEncrypted(path)
 if err!=nil{return "",func(){},errors.New("unable to inspect backup encryption header")}
 if !encrypted{return path,func(){},nil}
 if !validBackupSHA(strings.ToLower(expectedSHA)){return "",func(){},errors.New("invalid backup checksum")}
 staging,err:=os.CreateTemp(filepath.Dir(path),".clouddeck-local-restore-*.tar.gz")
 if err!=nil{return "",func(){},errors.New("unable to create decrypted local restore staging file")}
 decryptedPath:=staging.Name()
 if err:=staging.Close();err!=nil{_ = os.Remove(decryptedPath);return "",func(){},errors.New("unable to prepare decrypted local restore staging file")}
 _=os.Remove(decryptedPath)
 cleanup:=func(){_ = os.Remove(decryptedPath)}
 if _,err:=decryptBackupPayloadWithConfiguredKey(path,decryptedPath);err!=nil{cleanup();return "",func(){},err}
 actual,err:=backupFileSHA256(decryptedPath)
 if err!=nil{cleanup();return "",func(){},errors.New("unable to verify decrypted local backup checksum")}
 if !strings.EqualFold(actual,expectedSHA){cleanup();return "",func(){},errors.New("decrypted local backup checksum mismatch")}
 return decryptedPath,cleanup,nil
}
