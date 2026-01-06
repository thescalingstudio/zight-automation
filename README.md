# Zight Automation - Browserbase + Playwright

Automation to share files on Zight with emails from a public Google Sheet.

## 🚀 Features

- Reads emails from a public Google Sheet
- Automatically logs into Zight
- Shares files (1 email at a time for reliability)
- Supports **Browserbase Cloud** or **Local Playwright**
- **NEW:** Webhook API for Airtable integration

## 📋 Prerequisites

- Node.js 18+ installed
- Browserbase account (optional - can use local Playwright)

## 🛠️ Installation

1. **Install dependencies:**

```bash
npm install
```

2. **Configure environment variables:**

```bash
# Copy the example file
copy env.example .env

# Edit the .env file with your credentials
```

3. **Install Playwright browsers (only for local mode):**

```bash
npx playwright install chromium
```

## ⚙️ Configuration

Edit the `.env` file with your settings:

### Browserbase (Cloud)

```env
BROWSERBASE_API_KEY=bb_live_xxxxx
BROWSERBASE_PROJECT_ID=xxxxx
BROWSERBASE_ENABLED=true
```

To get credentials:
1. Visit https://www.browserbase.com/
2. Create an account or log in
3. Go to Settings > API Keys
4. Copy the API Key and Project ID

### Zight

```env
ZIGHT_USERNAME=your_email@example.com
ZIGHT_PASSWORD=your_password
```

### Google Sheet

The sheet must be **public** (Anyone with the link can view).

```env
# Spreadsheet ID (from URL: https://docs.google.com/spreadsheets/d/THIS_ID/...)
SHEET_SPREADSHEET_ID=1KjLsWGHVfe_opY2NZC8ggf18NPSZuR7FFk20pTAQ1bE

# Sheet GID (usually 0 for the first tab)
SHEET_GID=0

# Column name with emails
SHEET_COLUMN_NAME=Email
```

## 🎮 Run

### Option 1: Manual Execution

#### Browserbase Mode (Cloud)

```bash
npm start
# or
node zight-automation.js
```

#### Local Mode (Playwright on your PC)

```bash
npm run start:local
# or
$env:BROWSERBASE_ENABLED="false"; node zight-automation.js
```

### Option 2: Webhook API (Airtable Integration)

Start the webhook server to receive automated triggers:

```bash
npm run webhook
```

The server will listen on port 3000 for POST requests:

```
POST http://localhost:3000/api/trigger-zight
Content-Type: application/json

{
  "sheetUrl": "https://docs.google.com/spreadsheets/d/YOUR_ID/edit#gid=0",
  "zightUsername": "your@email.com",
  "zightPassword": "your-password"
}
```

**See [WEBHOOK-SETUP.md](WEBHOOK-SETUP.md) for complete setup guide.**

## 📁 File Structure

```
zight-automation/
├── package.json              # Dependencies
├── .env                      # Your settings (create from example)
├── zight-automation.js       # Main Playwright script
├── webhook-server.js         # NEW: Webhook API server
├── ecosystem.config.cjs      # NEW: PM2 configuration
├── README.md                 # This file
├── WEBHOOK-SETUP.md          # NEW: Webhook setup guide
├── QUICK-START.md            # NEW: Quick start guide
├── CHANGELOG.md              # Version history
├── logs/                     # Execution logs (auto-created)
└── screenshots/              # Debug screenshots (auto-created)
```

## 🔧 How It Works

1. **Sheet Reading**: The script downloads the CSV from the public Google Sheet
2. **Login**: Authenticates to Zight with provided credentials
3. **Open File**: Navigates to the dashboard and opens the first file
4. **Share**: For each batch of 10 emails:
   - Opens the Share modal
   - Adds the emails
   - Clicks Send
5. **Repeat**: Continues until all emails are processed

## 🐛 Debugging

- Screenshots are automatically saved in `screenshots/` when errors occur
- Run with `HEADLESS=false` in `.env` to see the browser (local mode only)

## ⚠️ Important Notes

- The Google Sheet **must be public** for the script to read the emails
- Make sure the email column has the correct name (case-insensitive)
- The script assumes there is **at least one file** in the Zight dashboard
- It's recommended to test first with a small email list

## 📝 License

MIT
