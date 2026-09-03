---
# graylog-webhook

A lightweight Node.js webhook listener that serves as a replacement for the **"Legacy Alert Notification" Script Callbacks** and **Graylog Small Business "Script Notification"**. Graylog triggers an HTTP call to this service, which then invokes an appropriate shell script with the relevant fields from the alert message based on the `action` parameter.

## Background

Starting in December 2026, when the Graylog Small Business license expires, the ability to directly invoke a local script from an alert will no longer be available. This project recreates this workflow via a simple HTTP endpoint:

```
Alert triggert -> Graylog HTTP-Notification -> node-webhook (dieser Service) -> action-spezifisches .sh-Script
```

The service runs **exclusively on localhost** and is additionally protected by an API key.

## Features

- Pure Node.js/Express application, no external dependencies other than Express
- API key protection via `X-Api-Key` header (timing-safe compare)
- Any number of actions, each mapped to its own shell script
- Centralized logging including request ID (see `lib/logging.sh`)
- Runs as a systemd service (`simple` type)

---

## Requirements

- Node.js >= 16
- A Linux host with systemd (ideally the Graylog server itself)
- `bash`, `sudo` privileges for setup

---

## Installation

### 1. Clone the repository

```bash
git clone https://github.com/Coffee-IsLife/graylog_local_http-api.git /opt/graylog-webhook
cd /opt/graylog-webhook
```

### 2. Create the directory structure

The service expects the following structure:

```
/opt/graylog-webhook/
├── server.js
├── logger.js
├── lib/
│   └── logging.sh
├── actions/
│   ├── test.sh
/etc/graylog-webhook/
├── api.key
└── sms_it_empfaenger.txt        # optional, je nach genutzten Actions
/var/log/graylog-webhook/
└── notifications.log
```

Create the directories outside the repository:

```bash
sudo mkdir -p /etc/graylog-webhook
sudo mkdir -p /var/log/graylog-webhook
```

### 3. User & permissions

It is recommended **not** to run the service as root, but under a dedicated technical user. Exception: If actions require commands that need root privileges (e.g. `postfix`/`postdrop`, iptables, or similar), this must be solved in the respective script via `sudo` with granular permissions (`visudo`, `NOPASSWD` for exactly this command) – **do not** run the entire service as root if avoidable.

Example of a dedicated user:

```bash
sudo useradd --system --no-create-home --shell /usr/sbin/nologin graylog-webhook
# Alternativly you can use the user "graylog". If you do this, you need to use "graylog" instead "graylog-webhook" in all next commands.
```

Set permissions:

```bash
# Code-Verzeichnis
sudo chown -R graylog-webhook:graylog-webhook /opt/graylog-webhook
sudo chmod -R 750 /opt/graylog-webhook
sudo chmod +x /opt/graylog-webhook/actions/*.sh
sudo chmod +x /opt/graylog-webhook/lib/logging.sh

# Config (API-Key etc.) - nur vom Service-User lesbar
sudo chown -R graylog-webhook:graylog-webhook /etc/graylog-webhook
sudo chmod 750 /etc/graylog-webhook
sudo chmod 640 /etc/graylog-webhook/api.key

# Log-Verzeichnis
sudo chown -R graylog-webhook:graylog-webhook /var/log/graylog-webhook
sudo chmod 750 /var/log/graylog-webhook
```

**Important:** Check individually which permissions each action script requires for execution (e.g. sending mail via `sendmail`/`postfix`, network calls to a firewall API, etc.) and adjust group memberships or `sudoers` rules accordingly. Test each script manually under the service user:

```bash
sudo -u graylog-webhook /opt/graylog-webhook/actions/mail_to_user.sh -t test@example.com -z 2026-08-31T09:56:00Z
```

If the test does not run successfully, it is usually due to missing group permissions (e.g. the `postdrop` group for sending mail):

```bash
sudo usermod -aG postdrop graylog-webhook
```

### 4. Create an API key

The service requires an API key, which Graylog must send in the `X-Api-Key` header with every request.

```bash
openssl rand -hex 32 | sudo tee /etc/graylog-webhook/api.key
sudo chown graylog-webhook:graylog-webhook /etc/graylog-webhook/api.key
sudo chmod 640 /etc/graylog-webhook/api.key
```

Alternatively, the key can also be set via the `WEBHOOK_API_KEY` environment variable (e.g. in the systemd unit) – however, the file `/etc/graylog-webhook/api.key` takes precedence or is used as a fallback if the ENV variable is not set. See `server.js`:

```javascript
const API_KEY = process.env.WEBHOOK_API_KEY || readKeyFromFile();
```

### 5. Install dependencies

```bash
cd /opt/graylog-webhook
npm install
```

### 6. Set up the systemd service

File `/etc/systemd/system/graylog-webhook.service`:

```ini
[Unit]
Description=Graylog Webhook Listener
After=network.target

[Service]
Type=simple
User=graylog-webhook
Group=graylog-webhook
WorkingDirectory=/opt/graylog-webhook
ExecStart=/usr/bin/node /opt/graylog-webhook/server.js
Restart=on-failure
RestartSec=5
Environment=PORT=8123
Environment=HOST=127.0.0.1
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

Enable and start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now graylog-webhook.service
sudo systemctl status graylog-webhook.service
```

Check logs:

```bash
journalctl -u graylog-webhook.service -f
```

Health check (accessible without an API key, for monitoring):

```bash
curl http://127.0.0.1:8123/health
```

---

## Using with Graylog

Create an **HTTP notification** in the Graylog event definition / notification setup:

- **URL:** `http://127.0.0.1:8123/alert/<action>`
- **Method:** `POST`
- **Header:** `X-Api-Key: <your-api-key>`
- **Send API Key/Secret as Header:** `Enable this Checkbox`
- **Body:** Graylog automatically sends the complete event payload here (including `backlog`) – this is passed on 1:1 to the endpoint.

`<action>` is one of the supported values, e.g.:

| Action                        | Script                       |
|-------------------------------|-------------------------------|
| `mail_to_user`                | `mail_to_user.sh`             |
| `mail_to_user_batv`           | `mail_to_user_batv.sh`        |
| `sms_on_crit`                 | `sms_on_crit.sh`               |
| `block_client`                | `block_client.sh`              |

Example call (for manual testing):

```bash
curl -X POST http://127.0.0.1:8123/alert/mail_to_user \
  -H "X-Api-Key: <your-api-key>" \
  -H "Content-Type: application/json" \
  -d '{
    "backlog": [
      {
        "timestamp": "2026-08-31T09:56:00Z",
        "fields": {
          "to": "test.user@example.com",
          "reason": "Test-Alarm"
        }
      }
    ]
  }'

##  oder komplettes json:

```

---

## Customize your own actions / scripts

### Add a new action

> **⚠️ Important: Case sensitivity of fields**
> The field names extracted from the Graylog alert message (e.g. `From`, `To`, `Timestamp`), 
> are read **case-sensitively**. `from` and `From` are treated as different fields.
> Make sure that the spelling in your Graylog notification template exactly matches the 
> spelling expected in the respective `handle...()` case in `server.js`.


1. Place a new shell script under `actions/`, e.g. `actions/my_custom_action.sh`
2. Make it executable: `chmod +x actions/my_custom_action.sh`
3. Build a new `handle...()` handler in `server.js` that extracts the desired fields from `eventData.backlog[].fields` and passes them as CLI arguments to `runScript()`
4. Add the new case to the `switch (action)` block of the `/alert/:action` route

### Customize existing scripts

All scripts in `actions/` are independent of one another and are invoked with classic POSIX flags (`-t`, `-z`, `-a`, etc.) – analogous to `argparse` in the original Python approach. Adjust the argument list in the respective `handle...()` function in `server.js` if the required fields change.


### Logging

Each action script should include the central logging include at the beginning:

```bash
#!/bin/bash
source /opt/graylog-webhook/lib/logging.sh
```

This makes the function `log "Message"` available, which automatically writes to `/var/log/graylog-webhook/notifications.log` with a timestamp and the request ID (passed by the Node service via the `REQUEST_ID` ENV variable). This makes it possible to associate log lines across the Node API and shell script with an individual alert call using the request ID.

---

## Security notes

- By default, the service binds only to `127.0.0.1` – **never expose it on `0.0.0.0`**, unless deliberately protected by an additional reverse proxy/firewall.
- If the service runs as root (e.g. because an action script requires root privileges), this should be implemented using targeted `sudo` rules per command instead of a blanket root service.

**Example of a secure `/etc/sudoers.d/graylog-webhook` configuration:**
If your action `block_client.sh` needs to block IP addresses via `iptables`, allow the user *only* this command without a password (or other commands such as postcat):

```text
graylog-webhook ALL=(ALL) NOPASSWD: /usr/sbin/iptables *
graylog-webhook ALL=(root) NOPASSWD: /usr/sbin/postcat /var/spool/postfix/*
```
In the shell script, simply use `sudo /usr/sbin/iptables ...`.\
The * (wildcards) in sudoers mean that parameters may be passed. - for `postcat` there is the restriction that the file must also be located somewhere in the postqueue `/var/spool/postfix/`.

---

## Troubleshooting

- **Script receives empty/missing parameters (e.g. `-f ""`)**
  Check whether the field names in the Graylog notification message exactly (case-sensitively!) match the keys expected in `server.js`. `From` ≠ `from` ≠ `FROM`.
