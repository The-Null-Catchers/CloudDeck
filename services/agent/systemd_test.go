package main

import "testing"

func TestParseServiceList(t *testing.T) {
 input:="ssh.service loaded active running OpenSSH server daemon\npostgresql.service loaded inactive dead PostgreSQL\nnot-a-unit loaded active running ignored\n"
 rows:=parseServiceList(input)
 if len(rows)!=2 {t.Fatalf("expected 2 services, got %d",len(rows))}
 if rows[0].Name!="ssh.service" || rows[0].Sub!="running" {t.Fatalf("unexpected first service: %+v",rows[0])}
 if rows[1].Description!="PostgreSQL" {t.Fatalf("unexpected description: %q",rows[1].Description)}
}

func TestSystemdServiceName(t *testing.T) {
 valid:=[]string{"caddy.service","postgresql@17-main.service","clouddeck-agent.service"}
 for _,name:=range valid {if !systemdServiceName.MatchString(name){t.Fatalf("expected %q to be valid",name)}}
 invalid:=[]string{"../../etc/passwd","nginx","foo.service;reboot","foo service"}
 for _,name:=range invalid {if systemdServiceName.MatchString(name){t.Fatalf("expected %q to be invalid",name)}}
}
