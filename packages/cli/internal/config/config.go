package config

import (
	"os"
	"path/filepath"
)

func Dir() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".kusal")
}

func DBPath() string { return filepath.Join(Dir(), "kusal.db") }
func ConfigPath() string { return filepath.Join(Dir(), "config.json") }
func TunnelBin() string { return "cloudflared" }

func EnsureDir() error {
	return os.MkdirAll(Dir(), 0700)
}
