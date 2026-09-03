---
# graylog-webhook

Ein leichtgewichtiger Node.js-Webhook-Listener, der als Ersatz für die **"Legacy Alert Notification" Script-Callbacks** bzw. **Graylog Small Business "Script Notification"** dient. Graylog triggert einen HTTP-Call an diesen Service, welcher dann anhand des `action`-Parameters ein entsprechendes Shell-Script mit den relevanten Feldern aus der Alert-Message aufruft.

## Hintergrund

Ab Dezember 2026 entfällt mit dem Auslaufen der Graylog Small Business Lizenz die Möglichkeit, bei einem Alert direkt ein lokales Script aufzurufen. Dieses Projekt bildet diesen Workflow über einen einfachen HTTP-Endpunkt nach:

```
Alert triggert -> Graylog HTTP-Notification -> node-webhook (dieser Service) -> action-spezifisches .sh-Script
```

Der Service läuft **ausschließlich auf localhost** und ist zusätzlich per API-Key abgesichert.

## Features

- Reine Node.js/Express-Anwendung, keine externen Dependencies außer Express
- API-Key-Absicherung via `X-Api-Key` Header (timing-safe compare)
- Beliebig viele Actions, jede mappt auf ein eigenes Shell-Script
- Zentrales Logging inkl. Request-ID (siehe `lib/logging.sh`)
- Läuft als systemd Service (`simple` Typ)

---

## Voraussetzungen

- Node.js >= 16
- Ein Linux-Host mit systemd (idealerweise der Graylog-Server selbst)
- `bash`, `sudo`-Rechte für die Einrichtung

---

## Installation

### 1. Repository klonen

```bash
git clone https://github.com/Coffee-IsLife/graylog_local_http-api.git /opt/graylog-webhook
cd /opt/graylog-webhook
```

### 2. Ordnerstruktur anlegen

Der Service erwartet folgende Struktur:

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

Anlegen der Verzeichnisse außerhalb des Repos:

```bash
sudo mkdir -p /etc/graylog-webhook
sudo mkdir -p /var/log/graylog-webhook
```

### 3. User & Rechte

Es wird empfohlen, den Service **nicht als root** laufen zu lassen, sondern unter einem dedizierten technischen User. Ausnahme: Wenn Actions Befehle benötigen, die root-Rechte erfordern (z.B. `postfix`/`postdrop`, iptables o.ä.), muss das im jeweiligen Script per `sudo` mit granularen Rechten (`visudo`, `NOPASSWD` für genau diesen Befehl) gelöst werden – **nicht** den gesamten Service als root betreiben, falls vermeidbar.

Beispiel für einen dedizierten User:

```bash
sudo useradd --system --no-create-home --shell /usr/sbin/nologin graylog-webhook
# Alternativ kann einfach user graylog genutzt werden. - dieser muss dann in den weiteren befehlen unten statt "graylog-webhook" genutzt werden.
```

Rechte setzen:

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

**Wichtig:** Prüfe für jedes Action-Script individuell, welche Rechte es zur Ausführung benötigt (z.B. Mailversand via `sendmail`/`postfix`, Netzwerk-Calls zu einer Firewall-API etc.) und passe die Gruppenmitgliedschaften bzw. `sudoers`-Regeln entsprechend an. Teste jedes Script manuell unter dem Service-User:

```bash
sudo -u graylog-webhook /opt/graylog-webhook/actions/mail_to_user.sh -t test@example.com -z 2026-08-31T09:56:00Z
```

Läuft der Test nicht durch, liegt es in der Regel an fehlenden Gruppenrechten (z.B. `postdrop`-Gruppe für Mailversand):

```bash
sudo usermod -aG postdrop graylog-webhook
```

### 4. API-Key erstellen

Der Service benötigt einen API-Key, den Graylog bei jedem Request im Header `X-Api-Key` mitschicken muss.

```bash
openssl rand -hex 32 | sudo tee /etc/graylog-webhook/api.key
sudo chown graylog-webhook:graylog-webhook /etc/graylog-webhook/api.key
sudo chmod 640 /etc/graylog-webhook/api.key
```

Alternativ kann der Key auch per Environment-Variable `WEBHOOK_API_KEY` gesetzt werden (z.B. in der systemd Unit) – die Datei `/etc/graylog-webhook/api.key` hat aber Vorrang bzw. wird als Fallback genutzt, falls die ENV-Variable nicht gesetzt ist. Siehe `server.js`:

```javascript
const API_KEY = process.env.WEBHOOK_API_KEY || readKeyFromFile();
```

### 5. Dependencies installieren

```bash
cd /opt/graylog-webhook
npm install
```

### 6. systemd Service einrichten

Datei `/etc/systemd/system/graylog-webhook.service`:

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

Aktivieren und starten:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now graylog-webhook.service
sudo systemctl status graylog-webhook.service
```

Logs prüfen:

```bash
journalctl -u graylog-webhook.service -f
```

Health-Check (ohne API-Key erreichbar, für Monitoring):

```bash
curl http://127.0.0.1:8123/health
```

---

## Nutzung in Graylog

Im Graylog Event-Definition / Notification-Setup eine **HTTP Notification** anlegen:

- **URL:** `http://127.0.0.1:8123/alert/<action>`
- **Method:** `POST`
- **Header:** `X-Api-Key: <dein-api-key>`
- **Send API Key/Secret as Header:** `Enable this Checkbox`
- **Body:** Graylog schickt hier automatisch den vollständigen Event-Payload (inkl. `backlog`) mit – dieser wird 1:1 an den Endpunkt durchgereicht.

`<action>` ist einer der unterstützten Werte, z.B.:

| Action                        | Script                       |
|-------------------------------|-------------------------------|
| `mail_to_user`                | `mail_to_user.sh`             |
| `mail_to_user_batv`           | `mail_to_user_batv.sh`        |
| `sms_on_crit`                 | `sms_on_crit.sh`               |
| `block_client`                | `block_client.sh`              |

Beispiel-Call (zum manuellen Testen):

```bash
curl -X POST http://127.0.0.1:8123/alert/mail_to_user \
  -H "X-Api-Key: <dein-api-key>" \
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

## Eigene Actions / Scripts anpassen

### Neue Action hinzufügen

> **⚠️ Wichtig: Case-Sensitivity der Felder**
> Die Feldnamen, die aus der Graylog-Alert-Message extrahiert werden (z.B. `From`, `To`, `Timestamp`), 
> werden **case-sensitiv** ausgelesen. `from` und `From` werden als unterschiedliche Felder behandelt.
> Achte darauf, dass die Schreibweise in deiner Graylog-Notification-Template exakt mit der 
> Schreibweise übereinstimmt, die in `server.js` im jeweiligen `handle...()`-Case erwartet wird.


1. Neues Shell-Script unter `actions/` ablegen, z.B. `actions/my_custom_action.sh`
2. Ausführbar machen: `chmod +x actions/my_custom_action.sh`
3. In `server.js` einen neuen `handle...()`-Handler bauen, der die gewünschten Felder aus `eventData.backlog[].fields` extrahiert und als CLI-Argumente an `runScript()` übergibt
4. Im `switch (action)`-Block der Route `/alert/:action` den neuen Case ergänzen

### Bestehende Scripts anpassen

Alle Scripts in `actions/` sind unabhängig voneinander und werden mit klassischen POSIX-Flags (`-t`, `-z`, `-a` etc.) aufgerufen – analog zu `argparse` im ursprünglichen Python-Ansatz. Passe die Argumentliste in der jeweiligen `handle...()`-Funktion in `server.js` an, falls sich die benötigten Felder ändern.


### Logging

Jedes Action-Script sollte am Anfang die zentrale Logging-Include einbinden:

```bash
#!/bin/bash
source /opt/graylog-webhook/lib/logging.sh
```

Damit steht die Funktion `log "Nachricht"` zur Verfügung, welche automatisch mit Timestamp und der Request-ID (vom Node-Service übergeben via `REQUEST_ID` ENV-Var) in `/var/log/graylog-webhook/notifications.log` schreibt. So lassen sich Log-Zeilen über Node-API und Shell-Script hinweg anhand der Request-ID einem einzelnen Alert-Aufruf zuordnen.

---

## Sicherheitshinweise

- Der Service bindet standardmäßig nur auf `127.0.0.1` – **niemals auf `0.0.0.0` exponieren**, außer bewusst mit zusätzlichem Reverse-Proxy/Firewall-Schutz.
- Läuft der Service als root (z.B. weil ein Action-Script root-Rechte benötigt), sollte dies durch gezielte `sudo`-Regeln pro Kommando statt eines pauschalen Root-Service umgesetzt werden.

**Beispiel für eine sichere `/etc/sudoers.d/graylog-webhook` Konfiguration:**
Wenn deine Action `block_client.sh` IP-Adressen via `iptables` sperren muss, erlaube dem User *nur* diesen Befehl ohne Passwort (oder andere befehle wie z.b. postcat):

```text
graylog-webhook ALL=(ALL) NOPASSWD: /usr/sbin/iptables *
graylog-webhook ALL=(root) NOPASSWD: /usr/sbin/postcat /var/spool/postfix/*
```
Im Shell-Script nutzt du dann einfach `sudo /usr/sbin/iptables ...`.\
Die * (wildcards) in der sudoers stehen dafür, dass parameter übergeben werden dürfen. - für `postcat` gibt es die Einschränkung, dass die Datei auch in der postqueue `/var/spool/postfix/` irgendwo liegen muss.

---

## Troubleshooting

- **Script erhält leere/fehlende Parameter (z.B. `-f ""`)**
  Prüfe, ob die Feldnamen in der Graylog-Notification-Message exakt (case-sensitiv!) mit den 
  in `server.js` erwarteten Keys übereinstimmen. `From` ≠ `from` ≠ `FROM`.
