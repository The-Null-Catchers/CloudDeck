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
  func(p *deploymentExecutePayload){p.DeploymentType="compose"},
  func(p *deploymentExecutePayload){p.Runtime.ContainerName=ptrString("api;rm")},
  func(p *deploymentExecutePayload){p.Runtime.HostPort=ptrInt(70000)},
 }
 for i,mutate:=range tests{p:=validDeploymentPayload();mutate(&p);if validateDeploymentPayload(p)==nil{t.Fatalf("case %d should fail",i)}}
}
