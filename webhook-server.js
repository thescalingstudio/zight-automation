// ==============================
// WEBHOOK SERVER - Airtable Integration
// Receives POST requests and triggers Zight automation
// ==============================

import express from "express";
import cors from "cors";
import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";

const execPromise = promisify(exec);

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ========== CONFIGURATION ==========
const PORT = process.env.WEBHOOK_PORT || 3000;
const API_KEY = process.env.WEBHOOK_API_KEY || "zight-webhook-2026"; // Change this in production

// ========== EXPRESS SETUP ==========
const app = express();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Simple logging middleware
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// ========== HELPERS ==========

/**
 * Extract spreadsheet ID and GID from Google Sheets URL
 * Supports various URL formats
 */
function parseGoogleSheetUrl(url) {
  try {
    // Format 1: https://docs.google.com/spreadsheets/d/SPREADSHEET_ID/edit#gid=GID
    // Format 2: https://docs.google.com/spreadsheets/d/SPREADSHEET_ID/edit?gid=GID
    // Format 3: https://docs.google.com/spreadsheets/d/SPREADSHEET_ID

    const spreadsheetIdMatch = url.match(
      /\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/
    );
    if (!spreadsheetIdMatch) {
      throw new Error("Invalid Google Sheets URL - cannot find spreadsheet ID");
    }

    const spreadsheetId = spreadsheetIdMatch[1];

    // Try to extract GID
    let gid = "0"; // Default to first sheet
    const gidMatch = url.match(/[#?&]gid=([0-9]+)/);
    if (gidMatch) {
      gid = gidMatch[1];
    }

    return { spreadsheetId, gid };
  } catch (error) {
    throw new Error(`Failed to parse Google Sheets URL: ${error.message}`);
  }
}

/**
 * Validate request parameters
 */
function validateParams(body) {
  const errors = [];

  if (!body.sheetUrl) {
    errors.push("Missing required parameter: sheetUrl");
  } else {
    try {
      parseGoogleSheetUrl(body.sheetUrl);
    } catch (e) {
      errors.push(`Invalid sheetUrl: ${e.message}`);
    }
  }

  if (!body.zightUsername) {
    errors.push("Missing required parameter: zightUsername");
  }

  if (!body.zightPassword) {
    errors.push("Missing required parameter: zightPassword");
  }

  return errors;
}

/**
 * Create logs directory if it doesn't exist
 */
function ensureLogsDir() {
  const logsDir = path.join(__dirname, "logs");
  if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
  }
  return logsDir;
}

/**
 * Execute Zight automation script with parameters
 */
async function executeZightScript(sheetUrl, zightUsername, zightPassword) {
  const { spreadsheetId, gid } = parseGoogleSheetUrl(sheetUrl);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const jobId = `job-${timestamp}`;
  const logsDir = ensureLogsDir();
  const logFile = path.join(logsDir, `${jobId}.log`);

  console.log(`📋 Job ID: ${jobId}`);
  console.log(`📊 Sheet ID: ${spreadsheetId}, GID: ${gid}`);
  console.log(`👤 User: ${zightUsername}`);

  // Build environment variables
  const env = {
    ...process.env,
    BROWSERBASE_ENABLED: "false",
    HEADLESS: "true",
    SHEET_SPREADSHEET_ID: spreadsheetId,
    SHEET_GID: gid,
    ZIGHT_USERNAME: zightUsername,
    ZIGHT_PASSWORD: zightPassword,
  };

  // Execute the script
  const command = `node zight-automation.js`;

  try {
    console.log(`🚀 Executing: ${command}`);
    console.log(`📝 Logs will be saved to: ${logFile}`);

    // Execute and capture output
    const { stdout, stderr } = await execPromise(command, {
      env,
      cwd: __dirname,
      maxBuffer: 10 * 1024 * 1024, // 10MB buffer
    });

    // Save logs
    const logs = `STDOUT:\n${stdout}\n\nSTDERR:\n${stderr}`;
    fs.writeFileSync(logFile, logs);

    console.log(`✅ Job ${jobId} completed successfully`);

    return {
      success: true,
      jobId,
      stdout,
      stderr,
      logFile,
    };
  } catch (error) {
    console.error(`❌ Job ${jobId} failed:`, error.message);

    // Save error logs
    const errorLogs = `ERROR:\n${error.message}\n\nSTDOUT:\n${
      error.stdout || ""
    }\n\nSTDERR:\n${error.stderr || ""}`;
    fs.writeFileSync(logFile, errorLogs);

    return {
      success: false,
      jobId,
      error: error.message,
      stdout: error.stdout,
      stderr: error.stderr,
      logFile,
    };
  }
}

// ========== ROUTES ==========

/**
 * Health check endpoint
 */
app.get("/", (req, res) => {
  res.json({
    status: "online",
    service: "Zight Automation Webhook",
    version: "1.0.0",
    timestamp: new Date().toISOString(),
  });
});

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

/**
 * Main webhook endpoint - Trigger Zight automation
 * POST /api/trigger-zight
 *
 * Body:
 * {
 *   "sheetUrl": "https://docs.google.com/spreadsheets/d/ID/edit#gid=0",
 *   "zightUsername": "user@example.com",
 *   "zightPassword": "password"
 * }
 *
 * Optional Headers:
 * Authorization: Bearer YOUR_API_KEY
 */
app.post("/api/trigger-zight", async (req, res) => {
  try {
    console.log("\n🔔 Received trigger request");

    // Optional: API key authentication (uncomment for security)
    // const authHeader = req.headers.authorization;
    // if (!authHeader || !authHeader.startsWith("Bearer ")) {
    //   return res.status(401).json({
    //     success: false,
    //     error: "Missing or invalid Authorization header",
    //   });
    // }
    //
    // const token = authHeader.substring(7);
    // if (token !== API_KEY) {
    //   return res.status(401).json({
    //     success: false,
    //     error: "Invalid API key",
    //   });
    // }

    // Validate parameters
    const errors = validateParams(req.body);
    if (errors.length > 0) {
      console.log("❌ Validation errors:", errors);
      return res.status(400).json({
        success: false,
        errors,
      });
    }

    const { sheetUrl, zightUsername, zightPassword } = req.body;

    // Execute the script (synchronously for now - can be made async with job queue)
    console.log("⏳ Starting Zight automation...");
    const result = await executeZightScript(
      sheetUrl,
      zightUsername,
      zightPassword
    );

    if (result.success) {
      return res.json({
        success: true,
        message: "Zight automation completed successfully",
        jobId: result.jobId,
        logFile: result.logFile,
      });
    } else {
      return res.status(500).json({
        success: false,
        message: "Zight automation failed",
        error: result.error,
        jobId: result.jobId,
        logFile: result.logFile,
      });
    }
  } catch (error) {
    console.error("❌ Unexpected error:", error);
    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * Get logs for a specific job
 * GET /api/logs/:jobId
 */
app.get("/api/logs/:jobId", (req, res) => {
  try {
    const { jobId } = req.params;
    const logsDir = path.join(__dirname, "logs");
    const logFile = path.join(logsDir, `${jobId}.log`);

    if (!fs.existsSync(logFile)) {
      return res.status(404).json({
        success: false,
        error: "Log file not found",
      });
    }

    const logs = fs.readFileSync(logFile, "utf-8");
    res.json({
      success: true,
      jobId,
      logs,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * List all jobs
 * GET /api/jobs
 */
app.get("/api/jobs", (req, res) => {
  try {
    const logsDir = path.join(__dirname, "logs");
    if (!fs.existsSync(logsDir)) {
      return res.json({
        success: true,
        jobs: [],
      });
    }

    const files = fs.readdirSync(logsDir);
    const jobs = files
      .filter((f) => f.endsWith(".log"))
      .map((f) => {
        const jobId = f.replace(".log", "");
        const stats = fs.statSync(path.join(logsDir, f));
        return {
          jobId,
          createdAt: stats.birthtime,
          size: stats.size,
        };
      })
      .sort((a, b) => b.createdAt - a.createdAt);

    res.json({
      success: true,
      jobs,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// ========== START SERVER ==========
app.listen(PORT, () => {
  console.log("\n" + "=".repeat(50));
  console.log("🚀 Zight Webhook Server Started");
  console.log("=".repeat(50));
  console.log(`📡 Listening on port: ${PORT}`);
  console.log(`🔗 Webhook URL: http://localhost:${PORT}/api/trigger-zight`);
  console.log(`🏥 Health check: http://localhost:${PORT}/health`);
  console.log(`🔑 API Key: ${API_KEY} (change in production)`);
  console.log("=".repeat(50) + "\n");
});

// Handle graceful shutdown
process.on("SIGTERM", () => {
  console.log("🛑 Received SIGTERM, shutting down gracefully...");
  process.exit(0);
});

process.on("SIGINT", () => {
  console.log("🛑 Received SIGINT, shutting down gracefully...");
  process.exit(0);
});

