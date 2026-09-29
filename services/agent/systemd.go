package main

import (
 "context"
 "errors"
 "os/exec"
 "regexp"
 "strconv"
 "strings"
 "time"
)

type serviceSummary struct {
 Name string `json:"name"`
 Load string `json:"load"`
 Active string `json:"active"`
 Sub string `json:"sub"`
 Description string `json:"description"`
}

var systemdServiceName=regexp.MustCompile(`^[A-Za-z0-9@_.:-]+\.service$`)

func parseServiceList(output string) []serviceSummary {
 lines:=strings.Split(output,"\n")
 result:=make([]serviceSummary,0,len(lines))
 for _,line:=range lines {
  fields:=strings.Fields(line)
  if len(fields)<4 || !systemdServiceName.MatchString(fields[0]) {continue}
  description:=""
  if len(fields)>4 {description=strings.Join(fields[4:]," ")}
  result=append(result,serviceSummary{Name:fields[0],Load:fields[1],Active:fields[2],Sub:fields[3],Description:description})
  if len(result)>=500 {break}
 }
 return result
}

func listSystemdServices() ([]serviceSummary,error) {
 ctx,cancel:=context.WithTimeout(context.Background(),8*time.Second);defer cancel()
 command:=exec.CommandContext(ctx,"systemctl","list-units","--type=service","--all","--no-legend","--no-pager","--plain")
 output,err:=command.Output()
 if ctx.Err()!=nil{return nil,errors.New("systemd command timed out")}
 if err!=nil{return nil,errors.New("systemd is unavailable")}
 if len(output)>512*1024{return nil,errors.New("systemd response too large")}
 return parseServiceList(string(output)),nil
}

func controlSystemdService(serviceName,operation string) error {
 if !systemdServiceName.MatchString(serviceName){return errors.New("invalid service name")}
 if operation!="start" && operation!="stop" && operation!="restart"{return errors.New("operation not allowed")}
 ctx,cancel:=context.WithTimeout(context.Background(),12*time.Second);defer cancel()
 command:=exec.CommandContext(ctx,"systemctl",operation,"--",serviceName)
 if err:=command.Run();err!=nil {
  if ctx.Err()!=nil{return errors.New("systemd command timed out")}
  return errors.New("systemd action failed")
 }
 return nil
}

func tailSystemdLogs(serviceName string,limit int) ([]string,bool,error) {
 if !systemdServiceName.MatchString(serviceName){return nil,false,errors.New("invalid service name")}
 if limit<1 || limit>500{return nil,false,errors.New("invalid log limit")}
 ctx,cancel:=context.WithTimeout(context.Background(),8*time.Second);defer cancel()
 command:=exec.CommandContext(ctx,"journalctl","-u",serviceName,"-n",strconv.Itoa(limit),"--no-pager","--output=short-iso")
 output,err:=command.Output()
 if ctx.Err()!=nil{return nil,false,errors.New("journal query timed out")}
 if err!=nil{return nil,false,errors.New("journal unavailable")}
 truncated:=false
 if len(output)>256*1024 {output=output[:256*1024];truncated=true}
 raw:=strings.Split(strings.TrimSpace(string(output)),"\n")
 if len(raw)==1 && raw[0]=="" {return []string{},truncated,nil}
 result:=make([]string,0,len(raw))
 for _,line:=range raw {
  if len(line)>4000 {line=line[:4000];truncated=true}
  result=append(result,line)
  if len(result)>=limit {break}
 }
 return result,truncated,nil
}
