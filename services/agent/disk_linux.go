//go:build linux
package main
import "syscall"
func diskUsage(path string) float64 {var stat syscall.Statfs_t;if syscall.Statfs(path,&stat)!=nil || stat.Blocks==0{return 0};return 100*float64(stat.Blocks-stat.Bavail)/float64(stat.Blocks)}
