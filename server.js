const express = require('express');
const { spawn } = require('child_process');
const { log, timestamp } = require('./logger');
const crypto = require('crypto');
const fs = require('fs');

const app = express();
app.use(express.json({ limit: '5mb' }));

//const SCRIPT_BASE = '/usr/share/graylog-server/scripts/';
const SCRIPT_BASE = '/opt/graylog-webhook/actions/';

// -------------------- API Key Config --------------------
// Key kommt aus ENV-Var oder Datei - nicht hardcoded im Code!
const API_KEY = process.env.WEBHOOK_API_KEY || readKeyFromFile();

function readKeyFromFile() {
  try {
    return fs.readFileSync('/etc/graylog-webhook/api.key', 'utf8').trim();
  } catch (e) {
    return null;
  }
}

if (!API_KEY) {
  console.error('FATAL: No API key configured (env WEBHOOK_API_KEY or /etc/graylog-webhook/api.key)');
  process.exit(1);
}

// Timing-safe compare
function isValidKey(providedKey) {
  if (!providedKey) return false;
  const a = Buffer.from(providedKey);
  const b = Buffer.from(API_KEY);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function apiKeyAuth(req, res, next) {
  const key = req.header('X-Api-Key');
  if (!isValidKey(key)) {
    log('AUTH', `Rejected request from ${req.ip} - invalid/missing X-Api-Key`, true);
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// -------------------- Helpers --------------------

function buildArgs(pairs) {
  const args = [];
  for (const [flag, value] of pairs) {
    if (value !== undefined && value !== null && value !== '') {
      args.push(flag, String(value));
    }
  }
  return args;
}


function runScript(scriptName, args, pid, res) {
  const scriptPath = SCRIPT_BASE + scriptName;
  log(pid, `${timestamp()} cmd_line: ${scriptPath} ${args.join(' ')}`);

  const child = spawn(scriptPath, args, {
    env: {
      ...process.env,
      REQUEST_ID: pid,
    },
    detached: true,
    stdio: 'ignore',
  });
  child.on('close', (code) => {
    log(pid, `${timestamp()} script finished (exit code: ${code})`);
    log(pid, '============================================');
  });

  child.on('error', (err) => {
    log(pid, `${timestamp()} script failed to start: ${err.message}`);
    log(pid, '============================================');
  });

  child.unref();

  res.status(200).json({ status: 'ok', pid });
}

// -------------------- Action Handlers --------------------
// (handleMailToUser, handleBanHostSonicwallRadius,
//  handleSmsOnCrit, handleBlockClient)

function handleMailToUser(eventData, pid, res, batv = false) {
  const args = [];
  const backlog = eventData.backlog || [];

  for (const message of backlog) {
    const fields = message.fields || {};

    if (fields.to) args.push('-t', fields.to);
    if (fields.From) args.push('-f', fields.From);
    if (fields.from) args.push('-f', fields.from);
    if (fields.MailAction) args.push('-m', fields.MailAction);
    if (fields.reason) args.push('-r', fields.reason);
    if (fields.ReturnMessage) args.push('-r', fields.ReturnMessage);
    if (fields.BlockedFile) args.push('-b', String(fields.BlockedFile).replace(/"/g, ''));
    if (fields.MailID) args.push('-i', fields.MailID);
    if (message.timestamp) args.push('-z', message.timestamp);
    if (fields.To) args.push('-t', fields.To);
    if (fields.connectingip) args.push('-c', fields.connectingip);
  }

  const scriptName = batv ? 'mail_to_user_batv.sh' : 'mail_to_user.sh';
  runScript(scriptName, args, pid, res);
}


function handleSmsOnCrit(eventData, pid, res) {
  const args = ['-a', 'sms_on_crit'];
  const backlog = eventData.backlog || [];

  for (const message of backlog) {
    const fields = message.fields || {};

    if (fields.samba_ip && fields.samba_hostname) {
      args.push('-i', `${fields.samba_ip}(${fields.samba_hostname})`);
    }
    if (fields.samba_share) args.push('-s', fields.samba_share);
    if (fields.samba_ransomware) args.push('-r', fields.samba_ransomware);
    if (fields.samba_action) args.push('-w', fields.samba_action);
    if (fields.samba_item) args.push('-t', fields.samba_item);
    if (fields.samba_new_item) args.push('-n', fields.samba_new_item);
    if (message.source) args.push('-o', message.source);
    if (fields.samba_user) args.push('-u', fields.samba_user);
  }

  runScript('sms_on_crit.sh', args, pid, res);
}

function handleBlockClient(eventData, pid, res) {
  const args = ['-a', 'ENABLE'];
  const backlog = eventData.backlog || [];

  for (const message of backlog) {
    const fields = message.fields || {};
    if (fields.samba_ip) args.push('-i', fields.samba_ip);
    if (fields.samba_hostname) args.push('-h', fields.samba_hostname);
  }

  runScript('block_client.sh', args, pid, res);
}

// -------------------- Routes --------------------

// Health check ohne Auth (für systemd/monitoring)
app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.post('/alert/:action', apiKeyAuth, (req, res) => {
  const action = req.params.action;
  const pid = crypto.randomUUID().slice(0, 8);
  const eventData = req.body || { backlog: [] };

  log(pid, `${timestamp()} Action: ${action}`, false);

  switch (action) {
    case 'mail_to_user':
      return handleMailToUser(eventData, pid, res, false);
    case 'mail_to_user_batv':
      return handleMailToUser(eventData, pid, res, true);
    case 'sms_on_crit':
      return handleSmsOnCrit(eventData, pid, res);
    case 'block_client':
      return handleBlockClient(eventData, pid, res);
    default:
      log(pid, `Unknown action: ${action}`);
      return res.status(400).json({ error: `Unknown action: ${action}` });
  }
});

// localhost binden, kein 0.0.0.0! - If server runs remote, add the api-facing-local-ip of running-server
const PORT = process.env.PORT || 8123;
const HOST = process.env.HOST || '127.0.0.1';

app.listen(PORT, HOST, () => {
  console.log(`Graylog webhook listener running on ${HOST}:${PORT}`);
});
