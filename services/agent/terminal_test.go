package main

import (
 "context"
 "encoding/base64"
 "errors"
 "os"
 "os/exec"
 "testing"
 "time"
)

func TestTerminalValidation(t *testing.T){
 valid:="550e8400-e29b-41d4-a716-446655440000"
 if !terminalSessionID.MatchString(valid){t.Fatal("expected valid UUID")}
 if terminalSessionID.MatchString("not-a-session"){t.Fatal("accepted invalid session ID")}
 if !validTerminalSize(120,36){t.Fatal("expected standard terminal size")}
 if validTerminalSize(10,2)||validTerminalSize(501,201){t.Fatal("accepted unsafe terminal size")}
}

func TestTerminalInputBounds(t *testing.T){
 manager:=newTerminalManager(context.Background(),func(any)error{return nil})
 valid:="550e8400-e29b-41d4-a716-446655440000"
 if err:=manager.input(terminalInput{SessionID:valid,Data:"%%%"});err==nil{t.Fatal("accepted invalid base64")}
 oversized:=make([]byte,4097)
 if err:=manager.input(terminalInput{SessionID:valid,Data:base64.StdEncoding.EncodeToString(oversized)});err==nil{t.Fatal("accepted oversized input")}
}

func TestTerminalStopsProcessWhenOutputDeliveryFails(t *testing.T){
 ctx,cancel:=context.WithCancel(context.Background())
 defer cancel()
 reader,writer,err:=os.Pipe()
 if err!=nil{t.Fatal(err)}
 defer reader.Close()
 defer writer.Close()
 command:=exec.CommandContext(ctx,"/bin/sh","-c","printf ready; exec sleep 60")
 command.Stdout=writer
 if err:=command.Start();err!=nil{t.Fatal(err)}
 process:=&terminalProcess{file:reader,cancel:cancel}
 manager:=newTerminalManager(ctx,func(any)error{return errors.New("connection closed")})
 manager.sessions["session"]=process
 done:=make(chan struct{})
 go func(){manager.read("session",process,command);close(done)}()
 select{
 case <-done:
 case <-time.After(3*time.Second):
  cancel()
  <-done
  t.Fatal("terminal reader waited for a live shell after output delivery failed")
 }
 if command.ProcessState==nil{
  t.Fatal("terminal process was not reaped")
 }
 manager.mu.Lock()
 defer manager.mu.Unlock()
 if len(manager.sessions)!=0{t.Fatal("failed terminal session was not removed")}
}
