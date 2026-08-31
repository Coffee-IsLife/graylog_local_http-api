#!/bin/bash
##
## Gemeinsame Logging-Funktion für alle graylog-webhook Action-Scripts
##
## Nutzung im Script:
##   source /opt/graylog-webhook/lib/logging.sh
##   log "Action: mail_to_user"
##
## Erwartet optional die Env-Variable REQUEST_ID (von der Node-API gesetzt).
## Fällt darauf zurück "no-id", falls das Script manuell aufgerufen wird.
##

LOG_FILE="${LOG_FILE:-/var/log/graylog-webhook/notifications.log}"

function log() {
  local msg="$1"
  local ts
  ts="$(date '+%Y-%m-%d %H:%M:%S')"
  echo "${REQUEST_ID:-no-id} ${ts} ${msg}" >> "$LOG_FILE"
}
