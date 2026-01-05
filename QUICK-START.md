# ⚡ Quick Start - Webhook Setup

Quick guide to test the webhook before deploying.

---

## 🧪 Local Test (on your Windows)

### 1. Install dependencies

```bash
npm install
```

### 2. Start webhook server

```bash
npm run webhook
```

You should see:
```
🚀 Zight Webhook Server Started
📡 Listening on port: 3000
```

### 3. Test with PowerShell

**Open another PowerShell terminal and run:**

```powershell
$body = @{
    sheetUrl = "https://docs.google.com/spreadsheets/d/1KjLsWGHVfe_opY2NZC8ggf18NPSZuR7FFk20pTAQ1bE/edit#gid=0"
    zightUsername = "daniel@carrotsnotsticks.com"
    zightPassword = "Carrotsnotsticks1"
} | ConvertTo-Json

Invoke-RestMethod -Uri "http://localhost:3000/api/trigger-zight" -Method Post -Body $body -ContentType "application/json"
```

**Or just test the health check:**

```powershell
Invoke-RestMethod -Uri "http://localhost:3000/health"
```

---

## 🚀 Deploy on Server (when it works locally)

### 1. Connect to server

```bash
ssh andre@193.203.164.17
```

### 2. Update code

```bash
cd ~/zight-automation
git pull
npm install
```

### 3. Test manually (optional)

```bash
npm run webhook
```

**In another SSH terminal, test:**

```bash
curl http://localhost:3000/health
```

**Stop the server:** `Ctrl + C`

### 4. Start with PM2 (recommended)

```bash
# Install PM2 (only once)
sudo npm install -g pm2

# Start
pm2 start ecosystem.config.cjs

# View status
pm2 status

# View logs
pm2 logs zight-webhook

# Save configuration
pm2 save
```

---

## 🔗 Configure Airtable

### Webhook URL:
```
http://193.203.164.17:3000/api/trigger-zight
```

### Body (JSON):
```json
{
  "sheetUrl": "{Field: Google Sheet URL}",
  "zightUsername": "{Field: Zight Username}",
  "zightPassword": "{Field: Zight Password}"
}
```

---

## 📝 Useful commands

```bash
# View status
pm2 status

# View logs in real-time
pm2 logs zight-webhook

# Restart
pm2 restart zight-webhook

# Stop
pm2 stop zight-webhook

# View executed jobs
curl http://localhost:3000/api/jobs

# View logs of specific job
curl http://localhost:3000/api/logs/JOB_ID
```

---

## 🐛 Troubleshooting

### Webhook not responding?

```bash
# Check if it's running
pm2 status

# View logs
pm2 logs zight-webhook

# Restart
pm2 restart zight-webhook
```

### Playwright script error?

```bash
# View detailed logs
ls -lh logs/
cat logs/job-*.log

# View debug screenshots
ls -lh screenshots/
```

---

For complete documentation, see **WEBHOOK-SETUP.md**
