package main

import (
 "archive/tar"
 "compress/gzip"
 "context"
 "crypto/sha256"
 "encoding/hex"
 "encoding/json"
 "errors"
 "fmt"
 "io"
 "net/http"
 "net/url"
 "os"
 "path/filepath"
 "regexp"
 "strconv"
 "strings"
)

var backupIDPattern=regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}package main

import (
 "archive/tar"
 "compress/gzip"
 "context"
 "crypto/sha256"
 "encoding/hex"
 "encoding/json"
 "errors"
 "fmt"
 "io"
 "net/http"
 "net/url"
 "os"
 "path/filepath"
 "regexp"
 "strconv"
 "strings"
)

)
var backupVolumeName=regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$`)
var backupStorageKey=regexp.MustCompile(`^[0-9a-fA-F-]{36}\.tar\.gz$`)

type backupExecutePayload struct {
 BackupID string `json:"backupId"`
 Kind string `json:"kind"`
 Source string `json:"source"`
 TargetType string `json:"targetType"`
}

type backupExecutionResult struct {
 StorageKey string `json:"storageKey"`
 SizeBytes int64 `json:"sizeBytes"`
 SHA256 string `json:"sha256"`
 Verified bool `json:"verified"`
 EntryCount int `json:"entryCount"`
}

type countingWriter struct {
 writer io.Writer
 written int64
 limit int64
}

func (w *countingWriter) Write(p []byte)(int,error){
 if w.written+int64(len(p))>w.limit{return 0,errors.New("backup exceeds configured size limit")}
 n,err:=w.writer.Write(p)
 w.written+=int64(n)
 return n,err
}

func backupMaxBytes()int64{
 const defaultLimit int64=20*1024*1024*1024
 raw:=strings.TrimSpace(os.Getenv("CLOUDDECK_BACKUP_MAX_BYTES"))
 if raw==""{return defaultLimit}
 value,err:=strconv.ParseInt(raw,10,64)
 if err!=nil||value<1024*1024||value>1024*1024*1024*1024{return defaultLimit}
 return value
}

func pathInside(root,path string)bool{
 rel,err:=filepath.Rel(root,path)
 return err==nil && rel!=".." && !strings.HasPrefix(rel,".."+string(os.PathSeparator))
}

func resolveAllowedDirectory(source string)(string,error){
 if !filepath.IsAbs(source){return "",errors.New("backup directory source must be absolute")}
 resolved,err:=filepath.EvalSymlinks(filepath.Clean(source))
 if err!=nil{return "",errors.New("backup source is unavailable")}
 info,err:=os.Stat(resolved)
 if err!=nil||!info.IsDir(){return "",errors.New("backup source must be a directory")}
 roots:=strings.Split(os.Getenv("CLOUDDECK_BACKUP_SOURCE_ROOTS"),",")
 for _,candidate:=range roots{
  candidate=strings.TrimSpace(candidate)
  if candidate==""||!filepath.IsAbs(candidate){continue}
  root,err:=filepath.EvalSymlinks(filepath.Clean(candidate))
  if err!=nil{continue}
  if pathInside(root,resolved){return resolved,nil}
 }
 return "",errors.New("backup source is outside CLOUDDECK_BACKUP_SOURCE_ROOTS")
}

func resolveDockerVolume(name string)(string,error){
 if !backupVolumeName.MatchString(name){return "",errors.New("invalid Docker volume name")}
 client,err:=dockerClient()
 if err!=nil{return "",err}
 req,err:=http.NewRequest(http.MethodGet,"http://docker/volumes/"+url.PathEscape(name),nil)
 if err!=nil{return "",err}
 res,err:=client.Do(req)
 if err!=nil{return "",errors.New("Docker Engine unavailable")}
 defer res.Body.Close()
 if res.StatusCode!=http.StatusOK{return "",fmt.Errorf("Docker volume inspect returned HTTP %d",res.StatusCode)}
 var raw struct{Driver string `json:"Driver"`;Mountpoint string `json:"Mountpoint"`}
 if err:=json.NewDecoder(io.LimitReader(res.Body,64*1024)).Decode(&raw);err!=nil{return "",errors.New("invalid Docker volume response")}
 if raw.Driver!="local"||!filepath.IsAbs(raw.Mountpoint){return "",errors.New("only local Docker volumes are supported")}
 resolved,err:=filepath.EvalSymlinks(filepath.Clean(raw.Mountpoint))
 if err!=nil{return "",errors.New("Docker volume mountpoint is unavailable")}
 root:=strings.TrimSpace(os.Getenv("CLOUDDECK_DOCKER_VOLUME_ROOT"))
 if root==""{root="/var/lib/docker/volumes"}
 root,err=filepath.EvalSymlinks(filepath.Clean(root))
 if err!=nil||!pathInside(root,resolved){return "",errors.New("Docker volume mountpoint is outside the trusted volume root")}
 return resolved,nil
}

func addDirectoryToArchive(ctx context.Context,source string,tw *tar.Writer,maxBytes int64)(int,error){
 entries:=0
 var sourceBytes int64
 base:=filepath.Base(source)
 err:=filepath.WalkDir(source,func(path string,entry os.DirEntry,walkErr error)error{
  if walkErr!=nil{return walkErr}
  select{case <-ctx.Done():return ctx.Err();default:}
  if entry.Type()&os.ModeSymlink!=0{return fmt.Errorf("symlink not allowed in backup: %s",entry.Name())}
  info,err:=entry.Info()
  if err!=nil{return err}
  if !info.Mode().IsRegular()&&!info.IsDir(){return fmt.Errorf("special file not allowed in backup: %s",entry.Name())}
  rel,err:=filepath.Rel(source,path)
  if err!=nil{return err}
  name:=base
  if rel!="."{name=filepath.Join(base,rel)}
  name=filepath.ToSlash(name)
  header,err:=tar.FileInfoHeader(info,"")
  if err!=nil{return err}
  header.Name=name
  if info.IsDir()&&!strings.HasSuffix(header.Name,"/"){header.Name+="/"}
  if err:=tw.WriteHeader(header);err!=nil{return err}
  entries++
  if entries>1_000_000{return errors.New("backup contains too many entries")}
  if info.Mode().IsRegular(){
   if info.Size()<0||sourceBytes+info.Size()>maxBytes{return errors.New("backup source exceeds configured size limit")}
   sourceBytes+=info.Size()
   file,err:=os.Open(path)
   if err!=nil{return err}
   _,copyErr:=io.Copy(tw,file)
   closeErr:=file.Close()
   if copyErr!=nil{return copyErr}
   if closeErr!=nil{return closeErr}
  }
  return nil
 })
 return entries,err
}

func verifyBackupArchive(path string)(int,error){
 file,err:=os.Open(path)
 if err!=nil{return 0,err}
 defer file.Close()
 gz,err:=gzip.NewReader(file)
 if err!=nil{return 0,errors.New("backup gzip verification failed")}
 defer gz.Close()
 tr:=tar.NewReader(gz)
 entries:=0
 for{
  header,err:=tr.Next()
  if errors.Is(err,io.EOF){break}
  if err!=nil{return 0,errors.New("backup tar verification failed")}
  clean:=filepath.Clean(filepath.FromSlash(header.Name))
  if filepath.IsAbs(clean)||clean==".."||strings.HasPrefix(clean,".."+string(os.PathSeparator)){return 0,errors.New("backup contains unsafe archive path")}
  entries++
  if entries>1_000_000{return 0,errors.New("backup contains too many entries")}
  if _,err:=io.Copy(io.Discard,tr);err!=nil{return 0,errors.New("backup content verification failed")}
 }
 if entries==0{return 0,errors.New("backup archive is empty")}
 return entries,nil
}

func executeLocalBackup(ctx context.Context,payload backupExecutePayload)(backupExecutionResult,error){
 var out backupExecutionResult
 if !backupIDPattern.MatchString(payload.BackupID){return out,errors.New("invalid backup ID")}
 if payload.TargetType!="local"{return out,errors.New("unsupported backup target")}
 var source string
 var err error
 switch payload.Kind{
 case "directory":source,err=resolveAllowedDirectory(payload.Source)
 case "docker_volume":source,err=resolveDockerVolume(payload.Source)
 default:return out,errors.New("unsupported backup kind")
 }
 if err!=nil{return out,err}
 targetRoot:=strings.TrimSpace(os.Getenv("CLOUDDECK_BACKUP_DIR"))
 if targetRoot==""{targetRoot="/var/lib/clouddeck-agent/backups"}
 if !filepath.IsAbs(targetRoot){return out,errors.New("backup target directory must be absolute")}
 if err:=os.MkdirAll(targetRoot,0700);err!=nil{return out,errors.New("unable to create backup target directory")}
 targetRoot,err=filepath.EvalSymlinks(filepath.Clean(targetRoot))
 if err!=nil{return out,errors.New("unable to resolve backup target directory")}
 storageKey:=payload.BackupID+".tar.gz"
 path:=filepath.Join(targetRoot,storageKey)
 file,err:=os.OpenFile(path,os.O_WRONLY|os.O_CREATE|os.O_EXCL,0600)
 if err!=nil{return out,errors.New("unable to create backup archive")}
 ok:=false
 defer func(){_ = file.Close();if !ok{_ = os.Remove(path)}}()
 hash:=sha256.New()
 maxBytes:=backupMaxBytes()
 limited:=&countingWriter{writer:io.MultiWriter(file,hash),limit:maxBytes}
 gz:=gzip.NewWriter(limited)
 tw:=tar.NewWriter(gz)
 _,err=addDirectoryToArchive(ctx,source,tw,maxBytes)
 if closeErr:=tw.Close();err==nil{err=closeErr}
 if closeErr:=gz.Close();err==nil{err=closeErr}
 if syncErr:=file.Sync();err==nil{err=syncErr}
 if closeErr:=file.Close();err==nil{err=closeErr}
 if err!=nil{return out,err}
 verifiedEntries,err:=verifyBackupArchive(path)
 if err!=nil{return out,err}
 stat,err:=os.Stat(path)
 if err!=nil{return out,err}
 ok=true
 return backupExecutionResult{
  StorageKey:storageKey,
  SizeBytes:stat.Size(),
  SHA256:hex.EncodeToString(hash.Sum(nil)),
  Verified:true,
  EntryCount:verifiedEntries,
 },nil
}

func deleteLocalBackup(storageKey string)error{
 if !backupStorageKey.MatchString(storageKey){return errors.New("invalid backup storage key")}
 targetRoot:=strings.TrimSpace(os.Getenv("CLOUDDECK_BACKUP_DIR"))
 if targetRoot==""{targetRoot="/var/lib/clouddeck-agent/backups"}
 if !filepath.IsAbs(targetRoot){return errors.New("backup target directory must be absolute")}
 root,err:=filepath.EvalSymlinks(filepath.Clean(targetRoot))
 if err!=nil{return errors.New("unable to resolve backup target directory")}
 path:=filepath.Join(root,storageKey)
 if !pathInside(root,path){return errors.New("backup storage key escaped target directory")}
 if err:=os.Remove(path);err!=nil && !errors.Is(err,os.ErrNotExist){return errors.New("unable to remove backup archive")}
 return nil
}

func executeBackupCommand(ctx context.Context,command agentCommand,write func(any)error){
 result:=commandResult{Type:"command.result",RequestID:command.RequestID}
 if command.Type!="command"||command.RequestID==""||command.Action!="backup.execute"{result.Error="Invalid backup command";_ = write(result);return}
 var payload backupExecutePayload
 if err:=decodeStrict(command.Payload,&payload);err!=nil{result.Error="Invalid backup payload";_ = write(result);return}
 data,err:=executeLocalBackup(ctx,payload)
 if err!=nil{result.Error=err.Error();_ = write(result);return}
 result.Success=true
 result.Data=data
 _ = write(result)
}
