package main

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"os"
	"path/filepath"
	"testing"
)

func TestFilesystemRestoreRejectsUnsafeEntriesAndCleansStaging(t *testing.T) {
	cases := []struct {
		name   string
		header tar.Header
	}{
		{"absolute", tar.Header{Name: "/etc/passwd", Typeflag: tar.TypeReg}},
		{"traversal", tar.Header{Name: "data/../data/escape", Typeflag: tar.TypeReg}},
		{"wrong root", tar.Header{Name: "other/escape", Typeflag: tar.TypeReg}},
		{"symlink", tar.Header{Name: "data/link", Typeflag: tar.TypeSymlink, Linkname: "/etc/passwd"}},
		{"hard link", tar.Header{Name: "data/link", Typeflag: tar.TypeLink, Linkname: "data/value"}},
		{"device", tar.Header{Name: "data/device", Typeflag: tar.TypeChar}},
		{"fifo", tar.Header{Name: "data/pipe", Typeflag: tar.TypeFifo}},
		{"duplicate root", tar.Header{Name: "data/", Typeflag: tar.TypeDir}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			root := t.TempDir()
			target := filepath.Join(root, "data")
			if err := os.Mkdir(target, 0700); err != nil {
				t.Fatal(err)
			}
			file, err := os.CreateTemp(t.TempDir(), "archive-*.tar.gz")
			if err != nil {
				t.Fatal(err)
			}
			gz := gzip.NewWriter(file)
			tw := tar.NewWriter(gz)
			if err := tw.WriteHeader(&tar.Header{Name: "data/", Mode: 0750, Typeflag: tar.TypeDir}); err != nil {
				t.Fatal(err)
			}
			if err := tw.WriteHeader(&tc.header); err != nil {
				t.Fatal(err)
			}
			if err := tw.Close(); err != nil {
				t.Fatal(err)
			}
			if err := gz.Close(); err != nil {
				t.Fatal(err)
			}
			if err := file.Close(); err != nil {
				t.Fatal(err)
			}
			sum, err := backupFileSHA256(file.Name())
			if err != nil {
				t.Fatal(err)
			}
			if _, _, err := extractFilesystemArchive(context.Background(), file.Name(), target, sum); err == nil {
				t.Fatal("unsafe archive accepted")
			}
			entries, err := os.ReadDir(root)
			if err != nil {
				t.Fatal(err)
			}
			if len(entries) != 1 || entries[0].Name() != "data" {
				t.Fatalf("staging leaked: %v", entries)
			}
		})
	}
}
