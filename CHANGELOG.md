# Changelog - Zight Automation

## [1.1.0] - 2026-01-05

### ✨ Added - Webhook Integration

- **Webhook Server** (`webhook-server.js`)
  - Express.js API to receive requests from Airtable
  - Endpoint: `POST /api/trigger-zight` 
  - Accepts dynamic parameters: `sheetUrl`, `zightUsername`, `zightPassword`
  - Automatically extracts `spreadsheetId` and `gid` from Google Sheets URLs
  - Executes Playwright script with provided parameters
  - Automatic logs for each execution in `logs/`

- **New endpoints:**
  - `GET /health` - Health check
  - `GET /api/jobs` - List all executions
  - `GET /api/logs/:jobId` - View logs of specific execution

- **PM2 Configuration** (`ecosystem.config.cjs`)
  - Configuration to keep webhook server online 24/7
  - Auto-restart on failure
  - Log management

- **Documentation:**
  - `WEBHOOK-SETUP.md` - Complete setup and deploy guide
  - `QUICK-START.md` - Quick guide for testing
  - `test-webhook.json` - Request examples

- **Package updates:**
  - Added dependencies: `express`, `cors`
  - New scripts: `npm run webhook`, `npm run webhook:dev`

### 🔧 Changed

- Updated `.gitignore` to include logs and screenshots
- `zight-automation.js` already supported parameters via environment variables (no changes needed)

### 📝 Notes

- Original script (`zight-automation.js`) maintains full compatibility
- Can continue to use `npm start` for manual execution
- Webhook is optional - doesn't break existing functionality

---

## [1.0.0] - 2025-12-22

### ✨ Initial Release

- Playwright script for Zight automation
- Support for Browserbase Cloud and Playwright Local
- Read emails from public Google Sheets
- Automatic sharing in batches of 10 emails
- Automatic debug screenshots
