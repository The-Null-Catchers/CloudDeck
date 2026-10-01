package main

import (
 "archive/tar"
 "compress/gzip"
 "context"
 "crypto/sha256"
 "encoding/hex"
 "errors"
 "io"
 "os"
 "os/exec"
 "path/filepath"
 "strconv"
 "strings"
)

type databaseRestorePayload struct {
 BackupID string `json:"backupId"`
 Kind string `json:"kind"`
 DatabaseName string `json:"databaseName"`
 TargetType string `json:"targetType"`
 StorageKey string `json:"storageKey"`
 ExpectedSHA256 string `json:"expectedSha256"`
 Database *databaseBackupConfig `json:"database"`
 S3 *s3BackupConfig `json:"s3,omitempty"`
}

func restoreStagingRoot()(string,error){
 root:=strings.TrimSpace(os.Getenv("CLOUDDECK_BACKUP_DIR"))
 if root==""{root="/var/lib/clouddeck-agent/backups"}
 if !filepath.IsAbs(root){return "",errors.New("backup target directory must be absolute")}
 if err:=os.MkdirAll(root,0700);err!=nil{return "",errors.New("unable to create backup staging directory")}
 resolved,err:=filepath.EvalSymlinks(filepath.Clean(root))
 if err!=nil{return "",errors.New("unable to resolve backup staging directory")}
 return resolved,nil
}

func restoreArchivePath(ctx context.Context,payload databaseRestorePayload)(string,func(),error){
 expectedKey:=payload.BackupID+".tar.gz"
 if !backupIDPattern.MatchString(payload.BackupID){return "",func(){},errors.New("invalid backup ID")}
 if len(payload.ExpectedSHA256)!=64{return "",func(){},errors.New("invalid backup checksum")}
 if payload.TargetType=="local"{
  if payload.StorageKey!=expectedKey||payload.S3!=nil{return "",func(){},errors.New("invalid local restore storage key")}
  path,err:=localBackupArchivePath(payload.StorageKey)
  if err!=nil{return "",func(){},err}
  return path,func(){},nil
 }
 if payload.TargetType!="s3"{return "",func(){},errors.New("unsupported restore target")}
 if err:=validateS3BackupConfig(payload.S3);err!=nil{return "",func(){},err}
 if err:=validateS3StoredKey(*payload.S3,payload.StorageKey);err!=nil{return "",func(){},err}
 if filepath.Base(filepath.FromSlash(payload.StorageKey))!=expectedKey{return "",func(){},errors.New("S3 restore object does not match backup ID")}
 root,err:=restoreStagingRoot()
 if err!=nil{return "",func(){},err}
 file,err:=os.CreateTemp(root,".restore-download-*.tar.gz")
 if err!=nil{return "",func(){},errors.New("unable to create restore download staging file")}
 path:=file.Name()
 if err:=file.Close();err!=nil{_ = os.Remove(path);return "",func(){},errors.New("unable to prepare restore download staging file")}
 _ = os.Remove(path)
 cleanup:=func(){_ = os.Remove(path)}
 if err:=downloadS3Backup(ctx,*payload.S3,payload.StorageKey,path,payload.ExpectedSHA256);err!=nil{cleanup();return "",func(){},err}
 return path,cleanup,nil
}

func extractDatabaseRestoreDump(archivePath,kind,expectedSHA,stagingRoot string)(string,func(),error){
 file,err:=os.Open(archivePath)
 if err!=nil{return "",func(){},errors.New("backup archive is unavailable")}
 hash:=sha256.New()
 if _,err:=io.Copy(hash,file);err!=nil{file.Close();return "",func(){},errors.New("unable to verify backup archive checksum")}
 if err:=file.Close();err!=nil{return "",func(){},errors.New("unable to close backup archive")}
 if !strings.EqualFold(hex.EncodeToString(hash.Sum(nil)),expectedSHA){return "",func(){},errors.New("backup archive checksum mismatch")}

 tempDir,err:=os.MkdirTemp(stagingRoot,".database-restore-*")
 if err!=nil{return "",func(){},errors.New("unable to create database restore staging directory")}
 cleanup:=func(){_ = os.RemoveAll(tempDir)}
 if err:=os.Chmod(tempDir,0700);err!=nil{cleanup();return "",func(){},errors.New("unable to secure database restore staging directory")}

 archive,err:=os.Open(archivePath)
 if err!=nil{cleanup();return "",func(){},errors.New("backup archive is unavailable")}
 defer archive.Close()
 gz,err:=gzip.NewReader(archive)
 if err!=nil{cleanup();return "",func(){},errors.New("backup gzip restore verification failed")}
 defer gz.Close()
 tr:=tar.NewReader(gz)
 expectedName:="dump/database.dump"
 if kind=="mysql"{expectedName="dump/database.sql"}
 dumpPath:=filepath.Join(tempDir,filepath.Base(expectedName))
 found:=false
 for{
  header,err:=tr.Next()
  if errors.Is(err,io.EOF){break}
  if err!=nil{cleanup();return "",func(){},errors.New("backup tar restore verification failed")}
  name:=filepath.ToSlash(filepath.Clean(filepath.FromSlash(header.Name)))
  if name=="dump"||name=="dump/"{
   if header.Typeflag!=tar.TypeDir{cleanup();return "",func(){},errors.New("invalid database backup archive layout")}
   continue
  }
  if name!=expectedName||found||(header.Typeflag!=tar.TypeReg&&header.Typeflag!=tar.TypeRegA){
   cleanup();return "",func(){},errors.New("database backup archive contains unexpected entries")
  }
  if header.Size<=0||header.Size>backupMaxBytes(){cleanup();return "",func(){},errors.New("database restore dump size is invalid")}
  out,err:=os.OpenFile(dumpPath,os.O_WRONLY|os.O_CREATE|os.O_EXCL,0600)
  if err!=nil{cleanup();return "",func(){},errors.New("unable to create database restore dump")}
  copied,copyErr:=io.CopyN(out,tr,header.Size)
  syncErr:=out.Sync()
  closeErr:=out.Close()
  if copyErr!=nil||copied!=header.Size||syncErr!=nil||closeErr!=nil{cleanup();return "",func(){},errors.New("unable to extract database restore dump")}
  found=true
 }
 if !found{cleanup();return "",func(){},errors.New("database backup archive is missing its dump")}
 return dumpPath,cleanup,nil
}

func restoreDatabase(ctx context.Context,payload databaseRestorePayload)error{
 if payload.Kind!="postgres"&&payload.Kind!="mysql"{return errors.New("unsupported database restore kind")}
 if err:=validateDatabaseBackupConfig(payload.Kind,payload.DatabaseName,payload.Database);err!=nil{return err}
 archivePath,downloadCleanup,err:=restoreArchivePath(ctx,payload)
 if err!=nil{return err}
 defer downloadCleanup()
 root,err:=restoreStagingRoot()
 if err!=nil{return err}
 dumpPath,cleanup,err:=extractDatabaseRestoreDump(archivePath,payload.Kind,payload.ExpectedSHA256,root)
 if err!=nil{return err}
 defer cleanup()

 if payload.Kind=="postgres"{
  binary,err:=databaseTool("CLOUDDECK_PG_RESTORE_BIN","/usr/bin/pg_restore")
  if err!=nil{return err}
  pgpassPath:=filepath.Join(filepath.Dir(dumpPath),".pgpass")
  pgpass:=strings.Join([]string{pgpassEscape(payload.Database.Host),strconv.Itoa(payload.Database.Port),pgpassEscape(payload.DatabaseName),pgpassEscape(payload.Database.Username),pgpassEscape(payload.Database.Password)},":")+"\n"
  if err:=writeCredentialFile(pgpassPath,pgpass);err!=nil{return errors.New("unable to prepare PostgreSQL restore credentials")}
  command:=exec.CommandContext(ctx,binary,
   "--host",payload.Database.Host,
   "--port",strconv.Itoa(payload.Database.Port),
   "--username",payload.Database.Username,
   "--dbname",payload.DatabaseName,
   "--clean",
   "--if-exists",
   "--no-owner",
   "--no-privileges",
   "--exit-on-error",
   dumpPath,
  )
  command.Env=commandEnvironment("PGPASSFILE="+pgpassPath,"PGSSLMODE="+payload.Database.SSLMode)
  command.Stdout=io.Discard
  command.Stderr=io.Discard
  if err:=command.Run();err!=nil{
   if ctx.Err()!=nil{return errors.New("PostgreSQL restore timed out or was cancelled")}
   return errors.New("PostgreSQL restore command failed")
  }
  return nil
 }

 binary,err:=databaseTool("CLOUDDECK_MYSQL_BIN","/usr/bin/mysql")
 if err!=nil{return err}
 defaultsPath:=filepath.Join(filepath.Dir(dumpPath),"mysql.cnf")
 defaults:="[client]\npassword=\""+mysqlOptionEscape(payload.Database.Password)+"\"\n"
 if err:=writeCredentialFile(defaultsPath,defaults);err!=nil{return errors.New("unable to prepare MySQL restore credentials")}
 input,err:=os.Open(dumpPath)
 if err!=nil{return errors.New("unable to open MySQL restore dump")}
 defer input.Close()
 sslArg:="--ssl-mode=REQUIRED"
 if payload.Database.SSLMode=="disable"{sslArg="--ssl-mode=DISABLED"}
 command:=exec.CommandContext(ctx,binary,
  "--defaults-extra-file="+defaultsPath,
  "--host="+payload.Database.Host,
  "--port="+strconv.Itoa(payload.Database.Port),
  "--user="+payload.Database.Username,
  sslArg,
  "--database="+payload.DatabaseName,
 )
 command.Env=commandEnvironment()
 command.Stdin=input
 command.Stdout=io.Discard
 command.Stderr=io.Discard
 if err:=command.Run();err!=nil{
  if ctx.Err()!=nil{return errors.New("MySQL restore timed out or was cancelled")}
  return errors.New("MySQL restore command failed")
 }
 return nil
}

func executeDatabaseRestoreCommand(ctx context.Context,command agentCommand,write func(any)error){
 result:=commandResult{Type:"command.result",RequestID:command.RequestID}
 if command.Type!="command"||command.RequestID==""||command.Action!="backup.restoreDatabase"{result.Error="Invalid database restore command";_ = write(result);return}
 var payload databaseRestorePayload
 if err:=decodeStrict(command.Payload,&payload);err!=nil{result.Error="Invalid database restore payload";_ = write(result);return}
 if err:=restoreDatabase(ctx,payload);err!=nil{result.Error=err.Error();_ = write(result);return}
 result.Success=true
 result.Data=map[string]bool{"restored":true}
 _ = write(result)
}
