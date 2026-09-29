package main

import "testing"

func ptrString(v string)*string{return &v}
func ptrInt(v int)*int{return &v}

func validDeploymentPayload()deploymentExecutePayload{
 return deploymentExecutePayload{
  DeploymentID:"123e4567-e89b-12d3-a456-426614174000",
  RepositoryFullName:"owner/repo",
  CommitSHA:"0123456789abcdef0123456789abcdef01234567",
  SourcePath:"Dockerfile",
  DeploymentType:"dockerfile",
  GithubToken:"ghs_exampletokenvalue",
  Runtime:deploymentRuntime{ContainerName:ptrString("clouddeck-api"),ContainerPort:ptrInt(4000),HostPort:ptrInt(14000),RestartPolicy:ptrString("unless-stopped")},
 }
}

func TestValidateDeploymentPayload(t *testing.T){
 p:=validDeploymentPayload()
 if err:=validateDeploymentPayload(p);err!=nil{t.Fatalf("expected valid payload: %v",err)}
}

func TestValidateDeploymentPayloadRejectsUnsafeValues(t *testing.T){
 tests:=[]func(*deploymentExecutePayload){
  func(p *deploymentExecutePayload){p.SourcePath="../Dockerfile"},
  func(p *deploymentExecutePayload){p.GithubToken="bad token"},
  func(p *deploymentExecutePayload){p.DeploymentType="compose";p.Runtime.ComposeProject=nil},
  func(p *deploymentExecutePayload){p.Runtime.ContainerName=ptrString("api;rm")},
  func(p *deploymentExecutePayload){p.Runtime.HostPort=ptrInt(70000)},
 }
 for i,mutate:=range tests{p:=validDeploymentPayload();mutate(&p);if validateDeploymentPayload(p)==nil{t.Fatalf("case %d should fail",i)}}
}


func validRollbackPayload()deploymentRollbackPayload{
 return deploymentRollbackPayload{
  DeploymentID:"123e4567-e89b-12d3-a456-426614174000",
  ContainerName:"clouddeck-api",
  CurrentContainerID:"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  PreviousContainerID:"abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
 }
}

func TestValidateRollbackPayload(t *testing.T){
 p:=validRollbackPayload()
 if err:=validateRollbackPayload(p);err!=nil{t.Fatalf("expected valid rollback payload: %v",err)}
}

func TestValidateRollbackPayloadRejectsUnsafeTargets(t *testing.T){
 tests:=[]func(*deploymentRollbackPayload){
  func(p *deploymentRollbackPayload){p.ContainerName="api;rm"},
  func(p *deploymentRollbackPayload){p.CurrentContainerID="bad"},
  func(p *deploymentRollbackPayload){p.PreviousContainerID=p.CurrentContainerID},
 }
 for i,mutate:=range tests{p:=validRollbackPayload();mutate(&p);if validateRollbackPayload(p)==nil{t.Fatalf("case %d should fail",i)}}
}


func TestValidateComposeDeploymentPayload(t *testing.T){
 p:=validDeploymentPayload()
 p.DeploymentType="compose"
 p.SourcePath="compose.yml"
 p.Runtime=deploymentRuntime{ComposeProject:ptrString("clouddeck-prod")}
 if err:=validateDeploymentPayload(p);err!=nil{t.Fatalf("expected valid Compose payload: %v",err)}
}


func validComposeRollbackPayload()composeRollbackPayload{
 return composeRollbackPayload{
  DeploymentID:"123e4567-e89b-12d3-a456-426614174000",
  ComposeProject:"clouddeck-prod",
  CurrentComposeContainerIDs:map[string]string{
   "api":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
   "worker":"1111111111111111111111111111111111111111111111111111111111111111",
  },
  PreviousComposeContainerIDs:map[string]string{
   "api":"abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
   "worker":"2222222222222222222222222222222222222222222222222222222222222222",
  },
 }
}

func TestValidateComposeRollbackPayload(t *testing.T){
 p:=validComposeRollbackPayload()
 if err:=validateComposeRollbackPayload(p);err!=nil{t.Fatalf("expected valid Compose rollback payload: %v",err)}
}

func TestValidateComposeRollbackPayloadRejectsBadMaps(t *testing.T){
 tests:=[]func(*composeRollbackPayload){
  func(p *composeRollbackPayload){p.ComposeProject="bad/project"},
  func(p *composeRollbackPayload){p.CurrentComposeContainerIDs["bad/service"]=p.CurrentComposeContainerIDs["api"]},
  func(p *composeRollbackPayload){p.PreviousComposeContainerIDs["api"]=p.CurrentComposeContainerIDs["api"]},
  func(p *composeRollbackPayload){p.PreviousComposeContainerIDs=map[string]string{}},
 }
 for i,mutate:=range tests{p:=validComposeRollbackPayload();mutate(&p);if validateComposeRollbackPayload(p)==nil{t.Fatalf("case %d should fail",i)}}
}
