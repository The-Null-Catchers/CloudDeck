package main

import (
 "archive/tar"
 "compress/gzip"
 "context"
 "crypto/sha256"
 "encoding/hex"
 "encoding/json"
 "errors"
 "io"
 "net/http"
 "os"
 "path/filepath"
 "strings"
)

type filesystemRestorePayload struct {
 BackupID string `json:"backupId"`
 Kind string `json:"kind"`
 Source string `json:"source"`
 TargetType string `json:"targetType"`
 StorageKey string `json:"storageKey"`
 ExpectedSHA256 string `json:"expectedSha256"`
 S3 *s3BackupConfig `json:"s3,omitempty"`
}

func dockerVolumeInUse(name string)(bool,error){
 if !backupVolumeName.MatchString(name){return false,errors.New("invalid Docker volume name")}
 res,err:=dockerRequest(http.MethodGet,"/containers/json?all=1&limit=500")
 if err!=nil{return false,err}
 defer res.Body.Close()
 var rows []struct{
  Mounts []struct{
   Type string `json:"Type"`
   Name string `json:"Name"`
  } `json:"Mounts"`
 }
 if err:=json.NewDecoder(io.LimitReader(res.Body,2*1024*1024)).Decode(&rows);err!=nil{return false,errors.New("invalid Docker container inventory response")}
 for _,row:=range rows{
  for _,mount:=range row.Mounts{
   if mount.Type=="volume"&&mount.Name==name{return true,nil}
  }
 }
 return false,nil
}

func filesystemRestoreArchivePath(ctx context.Context,payload filesystemRestorePayload)(string,func(),error){
 expectedKey:=payload.BackupID+".tar.gz"
 if !backupIDPattern.MatchString(payload.BackupID){return "",func(){},errors.New("invalid backup ID")}
 if !validBackupSHA(payload.ExpectedSHA256){return "",func(){},errors.New("invalid backup checksum")}
 if payload.TargetType=="local"{
  if payload.StorageKey!=expectedKey||payload.S3!=nil{return "",func(){},errors.New("invalid local restore storage key")}
  path,err:=localBackupArchivePath(payload.StorageKey)
  if err!=nil{return "",func(){},err}
  prepared,cleanup,err:=prepareBackupArchiveForRestore(path,payload.ExpectedSHA256)
  if err!=nil{return "",func(){},err}
  return prepared,cleanup,nil
 }
 if payload.TargetType!="s3"{return "",func(){},errors.New("unsupported restore target")}
 if err:=validateS3BackupConfig(payload.S3);err!=nil{return "",func(){},err}
 if err:=validateS3StoredKey(*payload.S3,payload.StorageKey);err!=nil{return "",func(){},err}
 if filepath.Base(filepath.FromSlash(payload.StorageKey))!=expectedKey{return "",func(){},errors.New("S3 restore object does not match backup ID")}
 root,err:=restoreStagingRoot()
 if err!=nil{return "",func(){},err}
 file,err:=os.CreateTemp(root,".filesystem-restore-download-*.tar.gz")
 if err!=nil{return "",func(){},errors.New("unable to create restore download staging file")}
 path:=file.Name()
 if err:=file.Close();err!=nil{_ = os.Remove(path);return "",func(){},errors.New("unable to prepare restore download staging file")}
 _=os.Remove(path)
 cleanup:=func(){_ = os.Remove(path)}
 if err:=downloadS3Backup(ctx,*payload.S3,payload.StorageKey,path,payload.ExpectedSHA256);err!=nil{cleanup();return "",func(){},err}
 return path,cleanup,nil
}

func verifyArchiveChecksum(path,expected string)error{
 file,err:=os.Open(path)
 if err!=nil{return errors.New("backup archive is unavailable")}
 defer file.Close()
 hash:=sha256.New()
 limited:=io.LimitReader(file,backupMaxBytes()+1)
 copied,err:=io.Copy(hash,limited)
 if err!=nil{return errors.New("unable to verify backup archive checksum")}
 if copied>backupMaxBytes(){return errors.New("backup archive exceeds configured size limit")}
 if !strings.EqualFold(hex.EncodeToString(hash.Sum(nil)),expected){return errors.New("backup archive checksum mismatch")}
 return nil
}

func extractFilesystemArchive(ctx context.Context,archivePath,target,expectedSHA string)(string,func(),error){
 if err:=verifyArchiveChecksum(archivePath,expectedSHA);err!=nil{return "",func(){},err}
 target=filepath.Clean(target)
 parent:=filepath.Dir(target)
 base:=filepath.Base(target)
 if base=="."||base==string(os.PathSeparator)||base==""{return "",func(){},errors.New("invalid restore target")}
 stage,err:=os.MkdirTemp(parent,"."+base+".clouddeck-restore-*")
 if err!=nil{return "",func(){},errors.New("unable to create restore staging directory")}
 cleanup:=func(){_ = os.RemoveAll(stage)}
 if err:=os.Chmod(stage,0700);err!=nil{cleanup();return "",func(){},errors.New("unable to secure restore staging directory")}

 archive,err:=os.Open(archivePath)
 if err!=nil{cleanup();return "",func(){},errors.New("backup archive is unavailable")}
 defer archive.Close()
 gz,err:=gzip.NewReader(archive)
 if err!=nil{cleanup();return "",func(){},errors.New("backup gzip restore verification failed")}
 defer gz.Close()
 tr:=tar.NewReader(gz)
 entries:=0
 var restoredBytes int64
 rootSeen:=false
 for{
  select{case <-ctx.Done():cleanup();return "",func(){},errors.New("filesystem restore was cancelled");default:}
  header,err:=tr.Next()
  if errors.Is(err,io.EOF){break}
  if err!=nil{cleanup();return "",func(){},errors.New("backup tar restore verification failed")}
  clean:=filepath.Clean(filepath.FromSlash(header.Name))
  if filepath.IsAbs(clean)||clean==".."||strings.HasPrefix(clean,".."+string(os.PathSeparator)){cleanup();return "",func(){},errors.New("backup archive contains unsafe path")}
  parts:=strings.Split(clean,string(os.PathSeparator))
  if len(parts)==0||parts[0]!=base{cleanup();return "",func(){},errors.New("backup archive root does not match restore target")}
  if len(parts)==1{
   if header.Typeflag!=tar.TypeDir{cleanup();return "",func(){},errors.New("backup archive root is not a directory")}
   rootSeen=true
   continue
  }
  if !rootSeen{cleanup();return "",func(){},errors.New("backup archive root directory is missing")}
  rel:=filepath.Join(parts[1:]...)
  destination:=filepath.Join(stage,rel)
  if !pathInside(stage,destination){cleanup();return "",func(){},errors.New("backup archive escaped restore staging directory")}
  entries++
  if entries>1_000_000{cleanup();return "",func(){},errors.New("backup archive contains too many entries")}
  switch header.Typeflag{
  case tar.TypeDir:
   if err:=os.MkdirAll(destination,0700);err!=nil{cleanup();return "",func(){},errors.New("unable to create restored directory")}
   _=os.Chmod(destination,os.FileMode(header.Mode)&0777)
  case tar.TypeReg,tar.TypeRegA:
   if header.Size<0||restoredBytes+header.Size>backupMaxBytes(){cleanup();return "",func(){},errors.New("restored content exceeds configured size limit")}
   restoredBytes+=header.Size
   if err:=os.MkdirAll(filepath.Dir(destination),0700);err!=nil{cleanup();return "",func(){},errors.New("unable to create restore parent directory")}
   file,err:=os.OpenFile(destination,os.O_WRONLY|os.O_CREATE|os.O_EXCL,0600)
   if err!=nil{cleanup();return "",func(){},errors.New("unable to create restored file")}
   copied,copyErr:=io.CopyN(file,tr,header.Size)
   syncErr:=file.Sync()
   closeErr:=file.Close()
   if copyErr!=nil||copied!=header.Size||syncErr!=nil||closeErr!=nil{cleanup();return "",func(){},errors.New("unable to extract restored file")}
   if err:=os.Chmod(destination,os.FileMode(header.Mode)&0777);err!=nil{cleanup();return "",func(){},errors.New("unable to apply restored file mode")}
  default:
   cleanup();return "",func(){},errors.New("backup archive contains unsupported entry type")
  }
 }
 if !rootSeen{cleanup();return "",func(){},errors.New("backup archive root directory is missing")}
 return stage,cleanup,nil
}

func replaceDirectoryWithRollback(target,stage,backupID string)error{
 target=filepath.Clean(target)
 parent:=filepath.Dir(target)
 base:=filepath.Base(target)
 rollback:=filepath.Join(parent,"."+base+".clouddeck-rollback-"+backupID)
 if _,err:=os.Lstat(rollback);err==nil{return errors.New("restore rollback path already exists")}
 if err:=os.Rename(target,rollback);err!=nil{return errors.New("unable to preserve current restore target")}
 restored:=false
 defer func(){
  if !restored{
   _=os.RemoveAll(target)
   _=os.Rename(rollback,target)
  }
 }()
 if err:=os.Rename(stage,target);err!=nil{return errors.New("unable to activate restored filesystem")}
 restored=true
 _=os.RemoveAll(rollback)
 return nil
}

func restoreFilesystem(ctx context.Context,payload filesystemRestorePayload)error{
 if payload.Kind!="directory"&&payload.Kind!="docker_volume"{return errors.New("unsupported filesystem restore kind")}
 var target string
 var err error
 if payload.Kind=="directory"{
  target,err=resolveAllowedDirectory(payload.Source)
 }else{
  if !backupVolumeName.MatchString(payload.Source){return errors.New("invalid Docker volume name")}
  inUse,useErr:=dockerVolumeInUse(payload.Source)
  if useErr!=nil{return useErr}
  if inUse{return errors.New("Docker volume restore requires the volume to be unused by all containers")}
  target,err=resolveDockerVolume(payload.Source)
 }
 if err!=nil{return err}
 archivePath,downloadCleanup,err:=filesystemRestoreArchivePath(ctx,payload)
 if err!=nil{return err}
 defer downloadCleanup()
 stage,stageCleanup,err:=extractFilesystemArchive(ctx,archivePath,target,payload.ExpectedSHA256)
 if err!=nil{return err}
 defer stageCleanup()
 if err:=replaceDirectoryWithRollback(target,stage,payload.BackupID);err!=nil{return err}
 return nil
}

func executeFilesystemRestoreCommand(ctx context.Context,command agentCommand,write func(any)error){
 result:=commandResult{Type:"command.result",RequestID:command.RequestID}
 if command.Type!="command"||command.RequestID==""||command.Action!="backup.restoreFilesystem"{result.Error="Invalid filesystem restore command";_ = write(result);return}
 var payload filesystemRestorePayload
 if err:=decodeStrict(command.Payload,&payload);err!=nil{result.Error="Invalid filesystem restore payload";_ = write(result);return}
 if err:=restoreFilesystem(ctx,payload);err!=nil{result.Error=err.Error();_ = write(result);return}
 result.Success=true
 result.Data=map[string]bool{"restored":true}
 _=write(result)
}
