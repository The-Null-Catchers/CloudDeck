package main

import (
 "bytes"
 "context"
 "encoding/base64"
 "os"
 "path/filepath"
 "testing"
)

// The complete restore path must authenticate and validate a backup before
// replacing a directory, including when a historical key has been rotated.
func TestDirectoryRestoreKeyRotationAndFailureIsolation(t *testing.T) {
 root := t.TempDir()
 source := filepath.Join(root, "lab-data")
 if err := os.Mkdir(source, 0700); err != nil { t.Fatal(err) }
 target := filepath.Join(source, "value.txt")
 unrelated := filepath.Join(root, "unrelated.txt")
 if err := os.WriteFile(target, []byte("original"), 0600); err != nil { t.Fatal(err) }
 if err := os.WriteFile(unrelated, []byte("untouched"), 0600); err != nil { t.Fatal(err) }
 t.Setenv("CLOUDDECK_BACKUP_SOURCE_ROOTS", root)
 t.Setenv("CLOUDDECK_BACKUP_DIR", t.TempDir())
 oldKey := base64.StdEncoding.EncodeToString(testEncryptionKey())
 newKey := base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{0x43}, 32))
 t.Setenv("CLOUDDECK_BACKUP_ENCRYPTION_KEY_VERSION", "1")
 t.Setenv("CLOUDDECK_BACKUP_ENCRYPTION_KEY", oldKey)
 const id = "40404040-4040-4040-8040-404040404040"
 backup, err := executeBackup(context.Background(), backupExecutePayload{BackupID:id,Kind:"directory",Source:source,TargetType:"local"})
 if err != nil { t.Fatal(err) }
 if backup.Encryption == nil || backup.Encryption.KeyVersion != 1 || backup.Encryption.Algorithm != backupEncryptionAlgorithm { t.Fatalf("unexpected encryption metadata: %+v", backup.Encryption) }
 archive, err := localBackupArchivePath(backup.StorageKey)
 if err != nil { t.Fatal(err) }
 cipherSHA, err := backupFileSHA256(archive)
 if err != nil || cipherSHA != backup.Encryption.CipherSHA256 { t.Fatalf("ciphertext checksum mismatch: %v", err) }
 originalCipher, err := os.ReadFile(archive)
 if err != nil { t.Fatal(err) }
 if err := os.WriteFile(target, []byte("current"), 0600); err != nil { t.Fatal(err) }
 if err := os.Chmod(target, 0644); err != nil { t.Fatal(err) }
 restore := func() error {
  return restoreFilesystem(context.Background(), filesystemRestorePayload{BackupID:id,Kind:"directory",Source:source,TargetType:"local",StorageKey:backup.StorageKey,ExpectedSHA256:backup.SHA256})
 }
 assertFile := func(path,want string,mode os.FileMode) {
  t.Helper()
  data,err:=os.ReadFile(path)
  if err!=nil||string(data)!=want { t.Fatalf("unexpected file contents for %s: %q (%v)",path,data,err) }
  info,err:=os.Stat(path)
  if err!=nil { t.Fatal(err) }
  if info.Mode().Perm()!=mode { t.Fatalf("file mode = %o, want %o",info.Mode().Perm(),mode) }
 }
 assertUnchanged := func() { t.Helper(); assertFile(target,"current",0644); assertFile(unrelated,"untouched",0600) }
 t.Setenv("CLOUDDECK_BACKUP_ENCRYPTION_KEY_VERSION","2")
 t.Setenv("CLOUDDECK_BACKUP_ENCRYPTION_KEY",newKey)
 t.Setenv("CLOUDDECK_BACKUP_ENCRYPTION_KEY_V1","")
 if err:=restore();err==nil { t.Fatal("restore unexpectedly accepted missing historical key") }
 assertUnchanged()
 t.Setenv("CLOUDDECK_BACKUP_ENCRYPTION_KEY_V1",newKey)
 if err:=restore();err==nil { t.Fatal("restore unexpectedly accepted wrong historical key") }
 assertUnchanged()
 t.Setenv("CLOUDDECK_BACKUP_ENCRYPTION_KEY_V1",oldKey)
 tampered:=append([]byte(nil),originalCipher...)
 tampered[len(tampered)-1]^=1
 if err:=os.WriteFile(archive,tampered,0600);err!=nil { t.Fatal(err) }
 if err:=restore();err==nil { t.Fatal("restore unexpectedly accepted tampered ciphertext") }
 assertUnchanged()
 if err:=os.WriteFile(archive,originalCipher,0600);err!=nil { t.Fatal(err) }
 if err:=restore();err!=nil { t.Fatal(err) }
 assertFile(target,"original",0600)
 assertFile(unrelated,"untouched",0600)
 matches,err:=filepath.Glob(filepath.Join(filepath.Dir(archive),".clouddeck-local-restore-*"))
 if err!=nil||len(matches)!=0 { t.Fatalf("restore plaintext staging remains: %v (%v)",matches,err) }
}
