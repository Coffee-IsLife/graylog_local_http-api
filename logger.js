const fs = require('fs');
const path = require('path');

const LOG_FILE = '/var/log/graylog-webhook/notifications.log';

function timestamp() {
  const d = new Date();
  const pad = (n) => n.toString().padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
         `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function log(pid, message, withTimestamp = false) {
  const line = (withTimestamp ? `${timestamp()} ` : '') + `${pid} ${message}\n`;
  fs.appendFileSync(LOG_FILE, line);
}

module.exports = { log, timestamp };
