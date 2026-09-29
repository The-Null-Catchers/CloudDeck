//go:build !linux
package main
func diskUsage(path string) float64 {return 0}
