package main

import (
 "context"
 "encoding/base64"
 "testing"
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
