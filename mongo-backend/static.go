package main

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

func staticHandler(dir string) http.Handler {
	fs := http.FileServer(http.Dir(dir))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := strings.TrimPrefix(filepath.Clean(r.URL.Path), "/")
		if p == "" || p == "." {
			p = "index.html"
		}
		if _, err := os.Stat(filepath.Join(dir, p)); err != nil {
			r.URL.Path = "/index.html"
		}
		fs.ServeHTTP(w, r)
	})
}
