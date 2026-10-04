package main

import (
	"os"
	"os/signal"
	"syscall"
)

func registerSignals(ch chan<- os.Signal) { signal.Notify(ch, os.Interrupt, syscall.SIGTERM) }
