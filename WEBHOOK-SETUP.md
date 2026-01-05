# 🚀 Webhook Setup Guide - Zight Automation

Complete guide to setup and test the webhook server that receives requests from Airtable.

---

## 📋 What was implemented

### New files created:

1. **`webhook-server.js`** - Express.js server that receives webhooks
2. **`ecosystem.config.cjs`** - PM2 configuration to keep server online
3. **`WEBHOOK-SETUP.md`** - This file (documentation)

### Changes:

- **`package.json`** - Added dependencies: `express`, `cors`
- **New scripts:** `npm run webhook`, `npm run webhook:dev`

---

## 🛠️ Installing new dependencies

### On your local computer (for testing):

```bash
npm install
```

### On the server:

```bash
ssh andre@193.203.164.17
cd ~/zight-automation
git pull
npm install
```

---

## 🧪 Local Tests (before deploy)

### 1. Test on Windows (your computer)

```bash
# Terminal 1 - Start the webhook server
npm run webhook
```

You should see:
```
🚀 Zight Webhook Server Started
📡 Listening on port: 3000
🔗 Webhook URL: http://localhost:3000/api/trigger-zight
```

### 2. Test with Postman or curl

**Health check:**
```bash
curl http://localhost:3000/health
```

**Trigger automation (test example):**
```bash
curl -X POST http://localhost:3000/api/trigger-zight \
  -H "Content-Type: application/json" \
  -d "{
    \"sheetUrl\": \"https://docs.google.com/spreadsheets/d/1KjLsWGHVfe_opY2NZC8ggf18NPSZuR7FFk20pTAQ1bE/edit#gid=0\",
    \"zightUsername\": \"daniel@carrotsnotsticks.com\",
    \"zightPassword\": \"Carrotsnotsticks1\"
  }"
```

**On PowerShell (Windows):**
```powershell
$body = @{
    sheetUrl = "https://docs.google.com/spreadsheets/d/1KjLsWGHVfe_opY2NZC8ggf18NPSZuR7FFk20pTAQ1bE/edit#gid=0"
    zightUsername = "daniel@carrotsnotsticks.com"
    zightPassword = "Carrotsnotsticks1"
} | ConvertTo-Json

Invoke-RestMethod -Uri "http://localhost:3000/api/trigger-zight" -Method Post -Body $body -ContentType "application/json"
```

### 3. View logs

```bash
# List jobs
curl http://localhost:3000/api/jobs

# View specific log
curl http://localhost:3000/api/logs/job-2026-01-05T10-30-00-000Z
```

---

## 🚀 Deploy on Server

### Option 1: Run manually (for testing)

```bash
# Connect to server
ssh andre@193.203.164.17

# Go to project
cd ~/zight-automation

# Update code
git pull

# Install dependencies
npm install

# Test the webhook server
npm run webhook
```

The server will be running. To test, open another terminal and make a POST request:

```bash
# Another terminal
ssh andre@193.203.164.17

# Test
curl -X POST http://localhost:3000/api/trigger-zight \
  -H "Content-Type: application/json" \
  -d '{"sheetUrl":"https://docs.google.com/spreadsheets/d/1KjLsWGHVfe_opY2NZC8ggf18NPSZuR7FFk20pTAQ1bE/edit#gid=0","zightUsername":"daniel@carrotsnotsticks.com","zightPassword":"Carrotsnotsticks1"}'
```

**To stop the server:** `Ctrl + C`

---

### Option 2: Run with PM2 (recommended - keeps it online)

```bash
# Install PM2 globally (only once)
sudo npm install -g pm2

# Start the webhook server with PM2
pm2 start ecosystem.config.cjs

# View status
pm2 status

# View logs in real-time
pm2 logs zight-webhook

# Stop logs (Ctrl + C)

# Restart
pm2 restart zight-webhook

# Stop
pm2 stop zight-webhook

# Remove
pm2 delete zight-webhook
```

#### Configure PM2 to start automatically after reboot:

```bash
pm2 startup
# Copy and execute the command that appears

pm2 save
```

---

## 🔗 Configure Airtable

### 1. In Airtable, create fields in the table:

- **Google Sheet URL** (type: URL or Single line text)
- **Zight Username** (type: Single line text)
- **Zight Password** (type: Single line text)

### 2. Create Automation in Airtable:

**Trigger:**
- When: Record is created
- Or: When button is clicked
- Or: When record enters view

**Action:**
- Choose action: **Send webhook**
- Configuration:
  - **Method:** POST
  - **URL:** `http://193.203.164.17:3000/api/trigger-zight`
  - **Headers:** (empty for now)
  - **Body:**

```json
{
  "sheetUrl": "{Field: Google Sheet URL}",
  "zightUsername": "{Field: Zight Username}",
  "zightPassword": "{Field: Zight Password}"
}
```

### 3. Test in Airtable:

- Create a test record
- Check if the webhook was called
- View logs on server: `pm2 logs zight-webhook`

---

## 📊 Available endpoints

### 1. Health Check
```
GET http://193.203.164.17:3000/health
```

### 2. Trigger Automation
```
POST http://193.203.164.17:3000/api/trigger-zight

Body (JSON):
{
  "sheetUrl": "https://docs.google.com/spreadsheets/d/...",
  "zightUsername": "user@example.com",
  "zightPassword": "password"
}
```

### 3. List Jobs
```
GET http://193.203.164.17:3000/api/jobs
```

### 4. Get Logs
```
GET http://193.203.164.17:3000/api/logs/{jobId}
```

---

## 📝 Logs

All logs are saved in `~/zight-automation/logs/`:

- **`job-{timestamp}.log`** - Logs from each execution
- **`pm2-out.log`** - PM2 output
- **`pm2-error.log`** - PM2 errors

To view logs:

```bash
# PM2 logs
pm2 logs zight-webhook

# List all jobs
ls -lh logs/

# View specific log
cat logs/job-2026-01-05T10-30-00-000Z.log

# View latest logs
tail -f logs/job-*.log
```

---

## 🔧 Troubleshooting

### Problem: "Port 3000 already in use"

```bash
# See what's using the port
sudo lsof -i :3000

# Kill the process
kill -9 <PID>

# Or use another port
WEBHOOK_PORT=3001 npm run webhook
```

### Problem: "Cannot find module 'express'"

```bash
# Reinstall dependencies
rm -rf node_modules package-lock.json
npm install
```

### Problem: Webhook not responding from Airtable

1. Check if it's running:
   ```bash
   pm2 status
   ```

2. View logs:
   ```bash
   pm2 logs zight-webhook
   ```

3. Test locally on server:
   ```bash
   curl http://localhost:3000/health
   ```

4. Check firewall (if necessary):
   ```bash
   sudo ufw status
   sudo ufw allow 3000/tcp
   ```

### Problem: Playwright script fails

1. View detailed logs:
   ```bash
   cat logs/job-*.log
   ```

2. Check debug screenshots:
   ```bash
   ls -lh screenshots/
   ```

3. Test script manually:
   ```bash
   SHEET_SPREADSHEET_ID="1KjLsWGHVfe_opY2NZC8ggf18NPSZuR7FFk20pTAQ1bE" \
   ZIGHT_USERNAME="daniel@carrotsnotsticks.com" \
   ZIGHT_PASSWORD="Carrotsnotsticks1" \
   npm start
   ```

---

## 🔐 Security (Phase 2 - future)

For when you implement security:

1. **Enable API Key authentication** (already in code, just commented out):
   - Uncomment lines 176-189 in `webhook-server.js`
   - Add header in Airtable: `Authorization: Bearer YOUR_API_KEY`

2. **HTTPS/SSL:**
   - Use nginx as reverse proxy
   - Let's Encrypt certificate

3. **Firewall:**
   - Allow only Airtable IPs

---

## 📚 Quick command summary

```bash
# === ON SERVER ===

# Update code
cd ~/zight-automation && git pull && npm install

# Start webhook (manual)
npm run webhook

# Start webhook (PM2 - recommended)
pm2 start ecosystem.config.cjs

# View status
pm2 status

# View logs
pm2 logs zight-webhook

# Restart
pm2 restart zight-webhook

# Stop
pm2 stop zight-webhook

# === TESTING ===

# Health check
curl http://localhost:3000/health

# Trigger (replace values)
curl -X POST http://localhost:3000/api/trigger-zight \
  -H "Content-Type: application/json" \
  -d '{"sheetUrl":"URL","zightUsername":"USER","zightPassword":"PASS"}'

# View jobs
curl http://localhost:3000/api/jobs

# View logs of specific job
curl http://localhost:3000/api/logs/JOB_ID
```

---

## ✅ Deploy Checklist

- [ ] Git pull on server
- [ ] npm install
- [ ] Test manually: `npm run webhook`
- [ ] Test POST request with curl
- [ ] Verify it works
- [ ] Stop manual server (Ctrl+C)
- [ ] Start with PM2: `pm2 start ecosystem.config.cjs`
- [ ] Check status: `pm2 status`
- [ ] Configure Airtable automation
- [ ] Test from Airtable
- [ ] Check logs: `pm2 logs zight-webhook`
- [ ] Save PM2 config: `pm2 save`

---

## 🎯 Next steps (future)

1. **Security:**
   - HTTPS/SSL
   - API key authentication
   - Rate limiting

2. **Improvements:**
   - Job queue (for multiple simultaneous requests)
   - Notifications (Slack/email when finished)
   - Web dashboard to view status

3. **Monitoring:**
   - Alerts if server goes down
   - Usage metrics

---

## 📞 Support

If you have problems:

1. View logs: `pm2 logs zight-webhook`
2. View job logs: `ls -lh logs/`
3. Test health check: `curl http://localhost:3000/health`
4. Restart: `pm2 restart zight-webhook`

---

**Created on:** 2026-01-05  
**Version:** 1.0.0
