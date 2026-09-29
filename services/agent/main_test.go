package main
import("os";"testing")
func TestCredentialFilePermissions(t *testing.T){path:=t.TempDir()+"/credential.json";if err:=saveConfig(path,credentials{ServerID:"server",Credential:"secret"});err!=nil{t.Fatal(err)};info,err:=os.Stat(path);if err!=nil{t.Fatal(err)};if info.Mode().Perm()!=0600{t.Fatalf("file mode %o",info.Mode().Perm())};c,err:=readConfig(path);if err!=nil || c.Credential!="secret"{t.Fatalf("read credential: %v",err)}}
