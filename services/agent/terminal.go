package main

import (
 "context"
 "encoding/base64"
 "errors"
 "io"
 "os"
 "os/exec"
 "regexp"
 "sync"

 "github.com/creack/pty"
)

var terminalSessionID=regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$`)

type terminalOpen struct {
 Type string `json:"type"`
 SessionID string `json:"sessionId"`
 Cols uint16 `json:"cols"`
 Rows uint16 `json:"rows"`
}
type terminalInput struct {
 Type string `json:"type"`
 SessionID string `json:"sessionId"`
 Data string `json:"data"`
}
type terminalResize struct {
 Type string `json:"type"`
 SessionID string `json:"sessionId"`
 Cols uint16 `json:"cols"`
 Rows uint16 `json:"rows"`
}
type terminalClose struct {
 Type string `json:"type"`
 SessionID string `json:"sessionId"`
}

type terminalProcess struct {
 file *os.File
 cancel context.CancelFunc
 mu sync.Mutex
}
type terminalManager struct {
 ctx context.Context
 emit func(any) error
 mu sync.Mutex
 sessions map[string]*terminalProcess
}

func newTerminalManager(ctx context.Context,emit func(any) error)*terminalManager{
 return &terminalManager{ctx:ctx,emit:emit,sessions:map[string]*terminalProcess{}}
}
func validTerminalSize(cols,rows uint16)bool{return cols>=20&&cols<=500&&rows>=5&&rows<=200}

func (m *terminalManager) open(request terminalOpen) error {
 if !terminalSessionID.MatchString(request.SessionID){return errors.New("invalid terminal session ID")}
 if !validTerminalSize(request.Cols,request.Rows){return errors.New("invalid terminal size")}
 m.mu.Lock()
 if _,exists:=m.sessions[request.SessionID];exists{m.mu.Unlock();return errors.New("terminal session already exists")}
 sessionCtx,cancel:=context.WithCancel(m.ctx)
 shell:=os.Getenv("CLOUDDECK_TERMINAL_SHELL")
 if shell==""{shell="/bin/bash"}
 if len(shell)>255||shell[0]!='/'{cancel();m.mu.Unlock();return errors.New("terminal shell must be an absolute path")}
 command:=exec.CommandContext(sessionCtx,shell)
 command.Env=append(os.Environ(),"TERM=xterm-256color")
 file,err:=pty.StartWithSize(command,&pty.Winsize{Cols:request.Cols,Rows:request.Rows})
 if err!=nil{cancel();m.mu.Unlock();return errors.New("terminal unavailable")}
 process:=&terminalProcess{file:file,cancel:cancel}
 m.sessions[request.SessionID]=process
 m.mu.Unlock()
 go m.read(request.SessionID,process,command)
 return nil
}

func (m *terminalManager) read(id string,process *terminalProcess,command *exec.Cmd){
 buffer:=make([]byte,4096)
 streamInterrupted:=false
 for{
  count,err:=process.file.Read(buffer)
  if count>0{
   encoded:=base64.StdEncoding.EncodeToString(buffer[:count])
   if emitErr:=m.emit(map[string]any{"type":"terminal.data","sessionId":id,"data":encoded});emitErr!=nil{streamInterrupted=true;break}
  }
  if err!=nil{streamInterrupted=!errors.Is(err,io.EOF);break}
 }
 waitErr:=command.Wait()
 m.mu.Lock()
 current:=m.sessions[id]
 active:=current==process
 if active{delete(m.sessions,id)}
 m.mu.Unlock()
 _=process.file.Close()
 if !active{return}
 if streamInterrupted{_ = m.emit(map[string]any{"type":"terminal.exit","sessionId":id,"error":"terminal stream interrupted"});return}
 exitCode:=0
 if waitErr!=nil{
  exitCode=-1
  if exitError,ok:=waitErr.(*exec.ExitError);ok{exitCode=exitError.ExitCode()}
 }
 _ = m.emit(map[string]any{"type":"terminal.exit","sessionId":id,"exitCode":exitCode})
}

func (m *terminalManager) input(request terminalInput) error {
 if !terminalSessionID.MatchString(request.SessionID){return errors.New("invalid terminal session ID")}
 data,err:=base64.StdEncoding.DecodeString(request.Data)
 if err!=nil||len(data)>4096{return errors.New("invalid terminal input")}
 m.mu.Lock();process:=m.sessions[request.SessionID];m.mu.Unlock()
 if process==nil{return errors.New("terminal session not found")}
 process.mu.Lock();defer process.mu.Unlock()
 _,err=process.file.Write(data)
 return err
}
func (m *terminalManager) resize(request terminalResize) error {
 if !terminalSessionID.MatchString(request.SessionID)||!validTerminalSize(request.Cols,request.Rows){return errors.New("invalid terminal resize")}
 m.mu.Lock();process:=m.sessions[request.SessionID];m.mu.Unlock()
 if process==nil{return errors.New("terminal session not found")}
 return pty.Setsize(process.file,&pty.Winsize{Cols:request.Cols,Rows:request.Rows})
}
func (m *terminalManager) close(id string) {
 m.mu.Lock();process:=m.sessions[id];delete(m.sessions,id);m.mu.Unlock()
 if process!=nil{process.cancel();_ = process.file.Close()}
}
func (m *terminalManager) closeAll(){
 m.mu.Lock();sessions:=m.sessions;m.sessions=map[string]*terminalProcess{};m.mu.Unlock()
 for _,process:=range sessions{process.cancel();_ = process.file.Close()}
}
