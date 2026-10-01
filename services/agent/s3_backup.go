package main

import (
 "context"
 "crypto/hmac"
 "crypto/sha256"
 "encoding/hex"
 "errors"
 "fmt"
 "io"
 "net"
 "net/http"
 "net/url"
 "os"
 "path/filepath"
 "regexp"
 "sort"
 "strings"
 "time"
)

var s3BucketPattern=regexp.MustCompile(`^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$`)
var s3RegionPattern=regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9-]{0,63}$`)
var s3KeyPattern=regexp.MustCompile(`^[A-Za-z0-9._/-]{1,500}$`)

type s3BackupConfig struct {
 Endpoint string `json:"endpoint"`
 Region string `json:"region"`
 Bucket string `json:"bucket"`
 AccessKey string `json:"accessKey"`
 SecretKey string `json:"secretKey"`
 SessionToken string `json:"sessionToken,omitempty"`
 Prefix string `json:"prefix,omitempty"`
}

func safeCredentialValue(value string,max int)bool{
 if value==""||len(value)>max{return false}
 for _,character:=range value{
  if character<32||character==127{return false}
 }
 return true
}

func validateS3BackupConfig(config *s3BackupConfig)error{
 if config==nil{return errors.New("S3 backup target configuration is missing")}
 endpoint,err:=url.Parse(strings.TrimSpace(config.Endpoint))
 if err!=nil||endpoint.Hostname()==""||endpoint.User!=nil||endpoint.RawQuery!=""||endpoint.Fragment!=""||(endpoint.Path!=""&&endpoint.Path!="/"){
  return errors.New("invalid S3 endpoint")
 }
 if endpoint.Scheme!="https"{
  host:=strings.ToLower(endpoint.Hostname())
  ip:=net.ParseIP(host)
  if endpoint.Scheme!="http"||(host!="localhost"&&(ip==nil||!ip.IsLoopback())){return errors.New("S3 endpoint must use HTTPS")}
 }
 if !s3RegionPattern.MatchString(config.Region){return errors.New("invalid S3 region")}
 if !s3BucketPattern.MatchString(config.Bucket)||strings.Contains(config.Bucket,".."){return errors.New("invalid S3 bucket")}
 if !safeCredentialValue(config.AccessKey,256)||strings.ContainsAny(config.AccessKey," \t\r\n"){return errors.New("invalid S3 access key")}
 if !safeCredentialValue(config.SecretKey,512){return errors.New("invalid S3 secret key")}
 if config.SessionToken!=""&&!safeCredentialValue(config.SessionToken,4096){return errors.New("invalid S3 session token")}
 if len(config.Prefix)>200{return errors.New("invalid S3 prefix")}
 if config.Prefix!=""{
  if strings.HasPrefix(config.Prefix,"/")||strings.HasSuffix(config.Prefix,"/")||!s3KeyPattern.MatchString(config.Prefix){return errors.New("invalid S3 prefix")}
  for _,segment:=range strings.Split(config.Prefix,"/"){if segment==""||segment=="."||segment==".."{return errors.New("invalid S3 prefix")}}
 }
 return nil
}

func s3BackupObjectKey(config s3BackupConfig,storageKey string)(string,error){
 if !backupStorageKey.MatchString(storageKey){return "",errors.New("invalid backup storage key")}
 if config.Prefix==""{return storageKey,nil}
 return config.Prefix+"/"+storageKey,nil
}

func validateS3StoredKey(config s3BackupConfig,key string)error{
 if !s3KeyPattern.MatchString(key)||strings.HasPrefix(key,"/")||strings.Contains(key,"//"){return errors.New("invalid S3 backup object key")}
 segments:=strings.Split(key,"/")
 for _,segment:=range segments{if segment==""||segment=="."||segment==".."{return errors.New("invalid S3 backup object key")}}
 leaf:=segments[len(segments)-1]
 if !backupStorageKey.MatchString(leaf){return errors.New("invalid S3 backup object key")}
 if config.Prefix!=""&&!strings.HasPrefix(key,config.Prefix+"/"){return errors.New("S3 backup object is outside configured prefix")}
 return nil
}

func escapeS3Path(value string)string{
 segments:=strings.Split(value,"/")
 for index,segment:=range segments{segments[index]=url.PathEscape(segment)}
 return strings.Join(segments,"/")
}

func s3ObjectURL(config s3BackupConfig,key string)(*url.URL,error){
 endpoint,err:=url.Parse(strings.TrimSpace(config.Endpoint))
 if err!=nil{return nil,err}
 endpoint.Path="/"+config.Bucket+"/"+key
 endpoint.RawPath="/"+url.PathEscape(config.Bucket)+"/"+escapeS3Path(key)
 return endpoint,nil
}

func hmacSHA256(key []byte,value string)[]byte{
 mac:=hmac.New(sha256.New,key)
 _,_=mac.Write([]byte(value))
 return mac.Sum(nil)
}

func signS3Request(request *http.Request,config s3BackupConfig,payloadHash string,now time.Time,extra map[string]string){
 amzDate:=now.UTC().Format("20060102T150405Z")
 date:=now.UTC().Format("20060102")
 request.Header.Set("x-amz-date",amzDate)
 request.Header.Set("x-amz-content-sha256",payloadHash)
 if config.SessionToken!=""{request.Header.Set("x-amz-security-token",config.SessionToken)}
 for key,value:=range extra{request.Header.Set(key,value)}

 headers:=map[string]string{
  "host":request.URL.Host,
  "x-amz-content-sha256":payloadHash,
  "x-amz-date":amzDate,
 }
 if config.SessionToken!=""{headers["x-amz-security-token"]=config.SessionToken}
 for key,value:=range extra{headers[strings.ToLower(key)]=strings.TrimSpace(value)}
 names:=make([]string,0,len(headers))
 for name:=range headers{names=append(names,name)}
 sort.Strings(names)
 var canonicalHeaders strings.Builder
 for _,name:=range names{canonicalHeaders.WriteString(name);canonicalHeaders.WriteByte(':');canonicalHeaders.WriteString(strings.Join(strings.Fields(headers[name])," "));canonicalHeaders.WriteByte('\n')}
 signedHeaders:=strings.Join(names,";")
 canonicalRequest:=request.Method+"\n"+request.URL.EscapedPath()+"\n\n"+canonicalHeaders.String()+"\n"+signedHeaders+"\n"+payloadHash
 canonicalHash:=sha256.Sum256([]byte(canonicalRequest))
 scope:=date+"/"+config.Region+"/s3/aws4_request"
 stringToSign:="AWS4-HMAC-SHA256\n"+amzDate+"\n"+scope+"\n"+hex.EncodeToString(canonicalHash[:])
 dateKey:=hmacSHA256([]byte("AWS4"+config.SecretKey),date)
 regionKey:=hmacSHA256(dateKey,config.Region)
 serviceKey:=hmacSHA256(regionKey,"s3")
 signingKey:=hmacSHA256(serviceKey,"aws4_request")
 signature:=hex.EncodeToString(hmacSHA256(signingKey,stringToSign))
 request.Header.Set("Authorization","AWS4-HMAC-SHA256 Credential="+config.AccessKey+"/"+scope+", SignedHeaders="+signedHeaders+", Signature="+signature)
}

func s3HTTPClient(timeout time.Duration)*http.Client{
 return &http.Client{
  Timeout:timeout,
  CheckRedirect:func(_ *http.Request,_ []*http.Request)error{return http.ErrUseLastResponse},
 }
}

func emptySHA256()string{
 sum:=sha256.Sum256(nil)
 return hex.EncodeToString(sum[:])
}

func uploadS3Backup(ctx context.Context,config s3BackupConfig,path,localStorageKey,sha string)(string,error){
 if err:=validateS3BackupConfig(&config);err!=nil{return "",err}
 objectKey,err:=s3BackupObjectKey(config,localStorageKey)
 if err!=nil{return "",err}
 info,err:=os.Stat(path)
 if err!=nil||!info.Mode().IsRegular(){return "",errors.New("backup staging archive is unavailable")}
 file,err:=os.Open(path)
 if err!=nil{return "",errors.New("unable to open backup staging archive")}
 defer file.Close()
 target,err:=s3ObjectURL(config,objectKey)
 if err!=nil{return "",errors.New("invalid S3 target")}
 request,err:=http.NewRequestWithContext(ctx,http.MethodPut,target.String(),file)
 if err!=nil{return "",errors.New("unable to prepare S3 upload")}
 request.ContentLength=info.Size()
 request.Header.Set("Content-Type","application/gzip")
 extra:=map[string]string{"x-amz-meta-clouddeck-sha256":sha}
 signS3Request(request,config,sha,time.Now(),extra)
 response,err:=s3HTTPClient(30*time.Minute).Do(request)
 if err!=nil{return "",errors.New("S3 upload failed")}
 _,_=io.Copy(io.Discard,io.LimitReader(response.Body,64*1024))
 response.Body.Close()
 if response.StatusCode<200||response.StatusCode>=300{return "",fmt.Errorf("S3 upload returned HTTP %d",response.StatusCode)}

 head,err:=http.NewRequestWithContext(ctx,http.MethodHead,target.String(),nil)
 if err!=nil{return "",errors.New("unable to prepare S3 verification")}
 signS3Request(head,config,emptySHA256(),time.Now(),nil)
 verified,err:=s3HTTPClient(30*time.Second).Do(head)
 if err!=nil{return "",errors.New("S3 verification failed")}
 verified.Body.Close()
 if verified.StatusCode<200||verified.StatusCode>=300{return "",fmt.Errorf("S3 verification returned HTTP %d",verified.StatusCode)}
 if verified.ContentLength!=info.Size(){return "",errors.New("S3 verification size mismatch")}
 if !strings.EqualFold(strings.TrimSpace(verified.Header.Get("x-amz-meta-clouddeck-sha256")),sha){return "",errors.New("S3 verification checksum metadata mismatch")}
 return objectKey,nil
}

func downloadS3Backup(ctx context.Context,config s3BackupConfig,objectKey,destination,expectedSHA string)error{
 if err:=validateS3BackupConfig(&config);err!=nil{return err}
 if err:=validateS3StoredKey(config,objectKey);err!=nil{return err}
 if !regexp.MustCompile(`^[a-f0-9]{64}package main

import (
 "context"
 "crypto/hmac"
 "crypto/sha256"
 "encoding/hex"
 "errors"
 "fmt"
 "io"
 "net"
 "net/http"
 "net/url"
 "os"
 "path/filepath"
 "regexp"
 "sort"
 "strings"
 "time"
)

var s3BucketPattern=regexp.MustCompile(`^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$`)
var s3RegionPattern=regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9-]{0,63}$`)
var s3KeyPattern=regexp.MustCompile(`^[A-Za-z0-9._/-]{1,500}$`)

type s3BackupConfig struct {
 Endpoint string `json:"endpoint"`
 Region string `json:"region"`
 Bucket string `json:"bucket"`
 AccessKey string `json:"accessKey"`
 SecretKey string `json:"secretKey"`
 SessionToken string `json:"sessionToken,omitempty"`
 Prefix string `json:"prefix,omitempty"`
}

func safeCredentialValue(value string,max int)bool{
 if value==""||len(value)>max{return false}
 for _,character:=range value{
  if character<32||character==127{return false}
 }
 return true
}

func validateS3BackupConfig(config *s3BackupConfig)error{
 if config==nil{return errors.New("S3 backup target configuration is missing")}
 endpoint,err:=url.Parse(strings.TrimSpace(config.Endpoint))
 if err!=nil||endpoint.Hostname()==""||endpoint.User!=nil||endpoint.RawQuery!=""||endpoint.Fragment!=""||(endpoint.Path!=""&&endpoint.Path!="/"){
  return errors.New("invalid S3 endpoint")
 }
 if endpoint.Scheme!="https"{
  host:=strings.ToLower(endpoint.Hostname())
  ip:=net.ParseIP(host)
  if endpoint.Scheme!="http"||(host!="localhost"&&(ip==nil||!ip.IsLoopback())){return errors.New("S3 endpoint must use HTTPS")}
 }
 if !s3RegionPattern.MatchString(config.Region){return errors.New("invalid S3 region")}
 if !s3BucketPattern.MatchString(config.Bucket)||strings.Contains(config.Bucket,".."){return errors.New("invalid S3 bucket")}
 if !safeCredentialValue(config.AccessKey,256)||strings.ContainsAny(config.AccessKey," \t\r\n"){return errors.New("invalid S3 access key")}
 if !safeCredentialValue(config.SecretKey,512){return errors.New("invalid S3 secret key")}
 if config.SessionToken!=""&&!safeCredentialValue(config.SessionToken,4096){return errors.New("invalid S3 session token")}
 if len(config.Prefix)>200{return errors.New("invalid S3 prefix")}
 if config.Prefix!=""{
  if strings.HasPrefix(config.Prefix,"/")||strings.HasSuffix(config.Prefix,"/")||!s3KeyPattern.MatchString(config.Prefix){return errors.New("invalid S3 prefix")}
  for _,segment:=range strings.Split(config.Prefix,"/"){if segment==""||segment=="."||segment==".."{return errors.New("invalid S3 prefix")}}
 }
 return nil
}

func s3BackupObjectKey(config s3BackupConfig,storageKey string)(string,error){
 if !backupStorageKey.MatchString(storageKey){return "",errors.New("invalid backup storage key")}
 if config.Prefix==""{return storageKey,nil}
 return config.Prefix+"/"+storageKey,nil
}

func validateS3StoredKey(config s3BackupConfig,key string)error{
 if !s3KeyPattern.MatchString(key)||strings.HasPrefix(key,"/")||strings.Contains(key,"//"){return errors.New("invalid S3 backup object key")}
 segments:=strings.Split(key,"/")
 for _,segment:=range segments{if segment==""||segment=="."||segment==".."{return errors.New("invalid S3 backup object key")}}
 leaf:=segments[len(segments)-1]
 if !backupStorageKey.MatchString(leaf){return errors.New("invalid S3 backup object key")}
 if config.Prefix!=""&&!strings.HasPrefix(key,config.Prefix+"/"){return errors.New("S3 backup object is outside configured prefix")}
 return nil
}

func escapeS3Path(value string)string{
 segments:=strings.Split(value,"/")
 for index,segment:=range segments{segments[index]=url.PathEscape(segment)}
 return strings.Join(segments,"/")
}

func s3ObjectURL(config s3BackupConfig,key string)(*url.URL,error){
 endpoint,err:=url.Parse(strings.TrimSpace(config.Endpoint))
 if err!=nil{return nil,err}
 endpoint.Path="/"+config.Bucket+"/"+key
 endpoint.RawPath="/"+url.PathEscape(config.Bucket)+"/"+escapeS3Path(key)
 return endpoint,nil
}

func hmacSHA256(key []byte,value string)[]byte{
 mac:=hmac.New(sha256.New,key)
 _,_=mac.Write([]byte(value))
 return mac.Sum(nil)
}

func signS3Request(request *http.Request,config s3BackupConfig,payloadHash string,now time.Time,extra map[string]string){
 amzDate:=now.UTC().Format("20060102T150405Z")
 date:=now.UTC().Format("20060102")
 request.Header.Set("x-amz-date",amzDate)
 request.Header.Set("x-amz-content-sha256",payloadHash)
 if config.SessionToken!=""{request.Header.Set("x-amz-security-token",config.SessionToken)}
 for key,value:=range extra{request.Header.Set(key,value)}

 headers:=map[string]string{
  "host":request.URL.Host,
  "x-amz-content-sha256":payloadHash,
  "x-amz-date":amzDate,
 }
 if config.SessionToken!=""{headers["x-amz-security-token"]=config.SessionToken}
 for key,value:=range extra{headers[strings.ToLower(key)]=strings.TrimSpace(value)}
 names:=make([]string,0,len(headers))
 for name:=range headers{names=append(names,name)}
 sort.Strings(names)
 var canonicalHeaders strings.Builder
 for _,name:=range names{canonicalHeaders.WriteString(name);canonicalHeaders.WriteByte(':');canonicalHeaders.WriteString(strings.Join(strings.Fields(headers[name])," "));canonicalHeaders.WriteByte('\n')}
 signedHeaders:=strings.Join(names,";")
 canonicalRequest:=request.Method+"\n"+request.URL.EscapedPath()+"\n\n"+canonicalHeaders.String()+"\n"+signedHeaders+"\n"+payloadHash
 canonicalHash:=sha256.Sum256([]byte(canonicalRequest))
 scope:=date+"/"+config.Region+"/s3/aws4_request"
 stringToSign:="AWS4-HMAC-SHA256\n"+amzDate+"\n"+scope+"\n"+hex.EncodeToString(canonicalHash[:])
 dateKey:=hmacSHA256([]byte("AWS4"+config.SecretKey),date)
 regionKey:=hmacSHA256(dateKey,config.Region)
 serviceKey:=hmacSHA256(regionKey,"s3")
 signingKey:=hmacSHA256(serviceKey,"aws4_request")
 signature:=hex.EncodeToString(hmacSHA256(signingKey,stringToSign))
 request.Header.Set("Authorization","AWS4-HMAC-SHA256 Credential="+config.AccessKey+"/"+scope+", SignedHeaders="+signedHeaders+", Signature="+signature)
}

func s3HTTPClient(timeout time.Duration)*http.Client{
 return &http.Client{
  Timeout:timeout,
  CheckRedirect:func(_ *http.Request,_ []*http.Request)error{return http.ErrUseLastResponse},
 }
}

func emptySHA256()string{
 sum:=sha256.Sum256(nil)
 return hex.EncodeToString(sum[:])
}

func uploadS3Backup(ctx context.Context,config s3BackupConfig,path,localStorageKey,sha string)(string,error){
 if err:=validateS3BackupConfig(&config);err!=nil{return "",err}
 objectKey,err:=s3BackupObjectKey(config,localStorageKey)
 if err!=nil{return "",err}
 info,err:=os.Stat(path)
 if err!=nil||!info.Mode().IsRegular(){return "",errors.New("backup staging archive is unavailable")}
 file,err:=os.Open(path)
 if err!=nil{return "",errors.New("unable to open backup staging archive")}
 defer file.Close()
 target,err:=s3ObjectURL(config,objectKey)
 if err!=nil{return "",errors.New("invalid S3 target")}
 request,err:=http.NewRequestWithContext(ctx,http.MethodPut,target.String(),file)
 if err!=nil{return "",errors.New("unable to prepare S3 upload")}
 request.ContentLength=info.Size()
 request.Header.Set("Content-Type","application/gzip")
 extra:=map[string]string{"x-amz-meta-clouddeck-sha256":sha}
 signS3Request(request,config,sha,time.Now(),extra)
 response,err:=s3HTTPClient(30*time.Minute).Do(request)
 if err!=nil{return "",errors.New("S3 upload failed")}
 _,_=io.Copy(io.Discard,io.LimitReader(response.Body,64*1024))
 response.Body.Close()
 if response.StatusCode<200||response.StatusCode>=300{return "",fmt.Errorf("S3 upload returned HTTP %d",response.StatusCode)}

 head,err:=http.NewRequestWithContext(ctx,http.MethodHead,target.String(),nil)
 if err!=nil{return "",errors.New("unable to prepare S3 verification")}
 signS3Request(head,config,emptySHA256(),time.Now(),nil)
 verified,err:=s3HTTPClient(30*time.Second).Do(head)
 if err!=nil{return "",errors.New("S3 verification failed")}
 verified.Body.Close()
 if verified.StatusCode<200||verified.StatusCode>=300{return "",fmt.Errorf("S3 verification returned HTTP %d",verified.StatusCode)}
 if verified.ContentLength!=info.Size(){return "",errors.New("S3 verification size mismatch")}
 if !strings.EqualFold(strings.TrimSpace(verified.Header.Get("x-amz-meta-clouddeck-sha256")),sha){return "",errors.New("S3 verification checksum metadata mismatch")}
 return objectKey,nil
}

).MatchString(expectedSHA){return errors.New("invalid expected backup checksum")}
 target,err:=s3ObjectURL(config,objectKey)
 if err!=nil{return errors.New("invalid S3 target")}
 request,err:=http.NewRequestWithContext(ctx,http.MethodGet,target.String(),nil)
 if err!=nil{return errors.New("unable to prepare S3 restore download")}
 signS3Request(request,config,emptySHA256(),time.Now(),nil)
 response,err:=s3HTTPClient(30*time.Minute).Do(request)
 if err!=nil{return errors.New("S3 restore download failed")}
 defer response.Body.Close()
 if response.StatusCode<200||response.StatusCode>=300{return fmt.Errorf("S3 restore download returned HTTP %d",response.StatusCode)}
 remoteSHA:=strings.TrimSpace(response.Header.Get("x-amz-meta-clouddeck-sha256"))
 if !strings.EqualFold(remoteSHA,expectedSHA){return errors.New("S3 restore object checksum metadata mismatch")}
 file,err:=os.OpenFile(destination,os.O_WRONLY|os.O_CREATE|os.O_EXCL,0600)
 if err!=nil{return errors.New("unable to create S3 restore staging file")}
 ok:=false
 defer func(){_ = file.Close();if !ok{_ = os.Remove(destination)}}()
 hash:=sha256.New()
 limited:=&countingWriter{writer:io.MultiWriter(file,hash),limit:backupMaxBytes()}
 if _,err:=io.Copy(limited,response.Body);err!=nil{return errors.New("S3 restore download could not be stored")}
 if err:=file.Sync();err!=nil{return errors.New("S3 restore staging file could not be synced")}
 if err:=file.Close();err!=nil{return errors.New("S3 restore staging file could not be closed")}
 actual:=hex.EncodeToString(hash.Sum(nil))
 if !strings.EqualFold(actual,expectedSHA){return errors.New("S3 restore object checksum mismatch")}
 ok=true
 return nil
}

func deleteS3Backup(ctx context.Context,config s3BackupConfig,objectKey string)error{
 if err:=validateS3BackupConfig(&config);err!=nil{return err}
 if err:=validateS3StoredKey(config,objectKey);err!=nil{return err}
 target,err:=s3ObjectURL(config,objectKey)
 if err!=nil{return errors.New("invalid S3 target")}
 request,err:=http.NewRequestWithContext(ctx,http.MethodDelete,target.String(),nil)
 if err!=nil{return errors.New("unable to prepare S3 delete")}
 signS3Request(request,config,emptySHA256(),time.Now(),nil)
 response,err:=s3HTTPClient(30*time.Second).Do(request)
 if err!=nil{return errors.New("S3 delete failed")}
 _,_=io.Copy(io.Discard,io.LimitReader(response.Body,64*1024))
 response.Body.Close()
 if response.StatusCode<200||response.StatusCode>=300{return fmt.Errorf("S3 delete returned HTTP %d",response.StatusCode)}
 return nil
}

func localBackupArchivePath(storageKey string)(string,error){
 if !backupStorageKey.MatchString(storageKey){return "",errors.New("invalid backup storage key")}
 root:=strings.TrimSpace(os.Getenv("CLOUDDECK_BACKUP_DIR"))
 if root==""{root="/var/lib/clouddeck-agent/backups"}
 if !filepath.IsAbs(root){return "",errors.New("backup target directory must be absolute")}
 resolved,err:=filepath.EvalSymlinks(filepath.Clean(root))
 if err!=nil{return "",errors.New("unable to resolve backup target directory")}
 path:=filepath.Join(resolved,storageKey)
 if !pathInside(resolved,path){return "",errors.New("backup storage key escaped target directory")}
 return path,nil
}

func executeBackup(ctx context.Context,payload backupExecutePayload)(backupExecutionResult,error){
 if payload.TargetType=="local"{
  if payload.S3!=nil{return backupExecutionResult{},errors.New("unexpected S3 configuration for local backup")}
  return executeLocalBackup(ctx,payload)
 }
 if payload.TargetType!="s3"{return backupExecutionResult{},errors.New("unsupported backup target")}
 if err:=validateS3BackupConfig(payload.S3);err!=nil{return backupExecutionResult{},err}
 staging:=payload
 staging.TargetType="local"
 staging.S3=nil
 result,err:=executeLocalBackup(ctx,staging)
 if err!=nil{return backupExecutionResult{},err}
 path,err:=localBackupArchivePath(result.StorageKey)
 if err!=nil{_ = deleteLocalBackup(result.StorageKey);return backupExecutionResult{},err}
 defer func(){_ = os.Remove(path)}()
 objectKey,err:=uploadS3Backup(ctx,*payload.S3,path,result.StorageKey,result.SHA256)
 if err!=nil{return backupExecutionResult{},err}
 result.StorageKey=objectKey
 result.Verified=true
 return result,nil
}

func executeBackupDeleteS3Command(ctx context.Context,command agentCommand,write func(any)error){
 result:=commandResult{Type:"command.result",RequestID:command.RequestID}
 if command.Type!="command"||command.RequestID==""||command.Action!="backup.deleteS3"{result.Error="Invalid S3 backup delete command";_ = write(result);return}
 var payload struct{
  StorageKey string `json:"storageKey"`
  S3 s3BackupConfig `json:"s3"`
 }
 if err:=decodeStrict(command.Payload,&payload);err!=nil{result.Error="Invalid S3 backup delete payload";_ = write(result);return}
 if err:=deleteS3Backup(ctx,payload.S3,payload.StorageKey);err!=nil{result.Error=err.Error();_ = write(result);return}
 result.Success=true
 result.Data=map[string]bool{"ok":true}
 _ = write(result)
}
