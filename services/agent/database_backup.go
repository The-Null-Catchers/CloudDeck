package main

import (
 "context"
 "errors"
 "io"
 "os"
 "os/exec"
 "path/filepath"
 "regexp"
 "strconv"
 "strings"
)

type databaseBackupConfig struct {
 Host string `json:"host"`
 Port int `json:"port"`
 Username string `json:"username"`
 Password string `json:"password"`
 SSLMode string `json:"sslMode"`
}

var databaseHostPattern=regexp.MustCompile(`^[A-Za-z0-9_.:-]{1,253}$`)
var databaseNamePattern=regexp.MustCompile(`^[A-Za-z0-9_.-]{1,128}$`)
var databaseUserPattern=regexp.MustCompile(`^[^\s\x00-\x1f\x7f]{1,128}$`)

func validateDatabaseBackupConfig(kind,databaseName string,config *databaseBackupConfig) error {
 if kind!="postgres"&&kind!="mysql"{return errors.New("unsupported database backup kind")}
 if !databaseNamePattern.MatchString(databaseName){return errors.New("invalid database name")}
 if config==nil{return errors.New("database credentials are required")}
 if !databaseHostPattern.MatchString(config.Host){return errors.New("invalid database host")}
 if config.Port<1||config.Port>65535{return errors.New("invalid database port")}
 if !databaseUserPattern.MatchString(config.Username){return errors.New("invalid database username")}
 if config.Password==""||len(config.Password)>4096{return errors.New("invalid database password")}
 if config.SSLMode!="disable"&&config.SSLMode!="require"{return errors.New("invalid database SSL mode")}
 return nil
}

func databaseTool(envName,defaultPath string)(string,error){
 path:=strings.TrimSpace(os.Getenv(envName))
 if path==""{path=defaultPath}
 if !filepath.IsAbs(path){return "",errors.New("database backup tool path must be absolute")}
 info,err:=os.Stat(path)
 if err!=nil||info.IsDir()||info.Mode()&0111==0{return "",errors.New("database backup tooling is unavailable")}
 return path,nil
}

func writeCredentialFile(path,content string)error{
 return os.WriteFile(path,[]byte(content),0600)
}

func pgpassEscape(value string)string{
 value=strings.ReplaceAll(value,"\\","\\\\")
 return strings.ReplaceAll(value,":","\\:")
}

func mysqlOptionEscape(value string)string{
 value=strings.ReplaceAll(value,"\\","\\\\")
 value=strings.ReplaceAll(value,"\"","\\\"")
 value=strings.ReplaceAll(value,"\n","\\n")
 return strings.ReplaceAll(value,"\r","\\r")
}

func commandEnvironment(extra ...string)[]string{
 env:=os.Environ()
 for _,entry:=range extra{
  if entry!=""{env=append(env,entry)}
 }
 return env
}

func createDatabaseDump(ctx context.Context,kind,databaseName string,config *databaseBackupConfig,targetRoot string,maxBytes int64)(string,func(),error){
 if err:=validateDatabaseBackupConfig(kind,databaseName,config);err!=nil{return "",func(){},err}
 tempDir,err:=os.MkdirTemp(targetRoot,".database-backup-*")
 if err!=nil{return "",func(){},errors.New("unable to create database backup staging directory")}
 cleanup:=func(){_ = os.RemoveAll(tempDir)}
 if err:=os.Chmod(tempDir,0700);err!=nil{cleanup();return "",func(){},errors.New("unable to secure database backup staging directory")}
 dumpName:="database.dump"
 if kind=="mysql"{dumpName="database.sql"}
 dumpPath:=filepath.Join(tempDir,dumpName)
 file,err:=os.OpenFile(dumpPath,os.O_WRONLY|os.O_CREATE|os.O_EXCL,0600)
 if err!=nil{cleanup();return "",func(){},errors.New("unable to create database dump file")}
 limited:=&countingWriter{writer:file,limit:maxBytes}

 var command *exec.Cmd
 if kind=="postgres"{
  binary,toolErr:=databaseTool("CLOUDDECK_PG_DUMP_BIN","/usr/bin/pg_dump")
  if toolErr!=nil{_ = file.Close();cleanup();return "",func(){},toolErr}
  pgpassPath:=filepath.Join(tempDir,".pgpass")
  pgpass:=strings.Join([]string{pgpassEscape(config.Host),strconv.Itoa(config.Port),pgpassEscape(databaseName),pgpassEscape(config.Username),pgpassEscape(config.Password)},":")+"\n"
  if err:=writeCredentialFile(pgpassPath,pgpass);err!=nil{_ = file.Close();cleanup();return "",func(){},errors.New("unable to prepare PostgreSQL credentials")}
  command=exec.CommandContext(ctx,binary,
   "--host",config.Host,
   "--port",strconv.Itoa(config.Port),
   "--username",config.Username,
   "--dbname",databaseName,
   "--format=custom",
   "--no-owner",
   "--no-privileges",
  )
  command.Env=commandEnvironment("PGPASSFILE="+pgpassPath,"PGSSLMODE="+config.SSLMode)
 }else{
  binary,toolErr:=databaseTool("CLOUDDECK_MYSQLDUMP_BIN","/usr/bin/mysqldump")
  if toolErr!=nil{_ = file.Close();cleanup();return "",func(){},toolErr}
  sslArg:="--ssl-mode=REQUIRED"
  if config.SSLMode=="disable"{sslArg="--ssl-mode=DISABLED"}
  defaultsPath:=filepath.Join(tempDir,"mysql.cnf")
  defaults:="[client]\npassword=\""+mysqlOptionEscape(config.Password)+"\"\n"
  if err:=writeCredentialFile(defaultsPath,defaults);err!=nil{_ = file.Close();cleanup();return "",func(){},errors.New("unable to prepare MySQL credentials")}
  command=exec.CommandContext(ctx,binary,
   "--defaults-extra-file="+defaultsPath,
   "--host="+config.Host,
   "--port="+strconv.Itoa(config.Port),
   "--user="+config.Username,
   sslArg,
   "--single-transaction",
   "--routines",
   "--events",
   "--hex-blob",
   "--databases",databaseName,
  )
  command.Env=commandEnvironment()
 }
 command.Stdout=limited
 command.Stderr=io.Discard
 runErr:=command.Run()
 syncErr:=file.Sync()
 closeErr:=file.Close()
 if ctx.Err()!=nil{cleanup();return "",func(){},errors.New("database backup timed out or was cancelled")}
 if runErr!=nil{cleanup();return "",func(){},errors.New("database dump command failed")}
 if syncErr!=nil||closeErr!=nil{cleanup();return "",func(){},errors.New("database dump could not be flushed")}
 info,err:=os.Stat(dumpPath)
 if err!=nil||info.Size()==0{cleanup();return "",func(){},errors.New("database dump is empty")}

 if kind=="postgres"{
  restoreBinary,toolErr:=databaseTool("CLOUDDECK_PG_RESTORE_BIN","/usr/bin/pg_restore")
  if toolErr!=nil{cleanup();return "",func(){},toolErr}
  verify:=exec.CommandContext(ctx,restoreBinary,"--list",dumpPath)
  verify.Stdout=io.Discard
  verify.Stderr=io.Discard
  if err:=verify.Run();err!=nil{cleanup();return "",func(){},errors.New("PostgreSQL dump verification failed")}
 }
 return tempDir,cleanup,nil
}
