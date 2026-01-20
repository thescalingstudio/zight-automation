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
import {
  createCampaign,
  updateCampaignStatus,
  parseGoogleSheetUrl as parseSheetUrlSupabase,
  isSupabaseEnabled,
} from "./supabase-client.js";

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
async function executeZightScript(sheetUrl, zightUsername, zightPassword, submittedBy = null) {
  const { spreadsheetId, gid } = parseGoogleSheetUrl(sheetUrl);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const jobId = `job-${timestamp}`;
  const logsDir = ensureLogsDir();
  const logFile = path.join(logsDir, `${jobId}.log`);

  console.log(`📋 Job ID: ${jobId}`);
  console.log(`📊 Sheet ID: ${spreadsheetId}, GID: ${gid}`);
  console.log(`👤 User: ${zightUsername}`);

  let campaign = null;

  try {
    // 1. Create campaign in Supabase (if enabled)
    if (isSupabaseEnabled()) {
      console.log("💾 Creating campaign in Supabase...");
      campaign = await createCampaign({
        sheetUrl,
        sheetId: spreadsheetId,
        sheetGid: gid,
        zightUsername,
        submittedBy,
      });
      console.log(`📋 Campaign: #${campaign.campaign_number} (ID: ${campaign.id})`);

      // 2. Update status to in_progress
      await updateCampaignStatus(campaign.id, "in_progress");
    }

    // Build environment variables
    const env = {
      ...process.env,
      BROWSERBASE_ENABLED: "false",
      HEADLESS: "true",
      SHEET_SPREADSHEET_ID: spreadsheetId,
      SHEET_GID: gid,
      ZIGHT_USERNAME: zightUsername,
      ZIGHT_PASSWORD: zightPassword,
      // Pass campaign info to automation script
      CAMPAIGN_ID: campaign?.id || "",
      CAMPAIGN_NUMBER: campaign?.campaign_number?.toString() || "",
    };

    // Execute the script
    const command = `node zight-automation.js`;

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

    // 3. Update campaign status to completed (if Supabase enabled)
    if (campaign?.id) {
      await updateCampaignStatus(campaign.id, "completed");
    }

    console.log(`✅ Job ${jobId} completed successfully`);

    return {
      success: true,
      jobId,
      campaignId: campaign?.id,
      campaignNumber: campaign?.campaign_number,
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

    // 4. Update campaign status to failed (if campaign was created)
    if (campaign?.id) {
      await updateCampaignStatus(campaign.id, "failed", error.message);
    }

    return {
      success: false,
      jobId,
      campaignId: campaign?.id,
      campaignNumber: campaign?.campaign_number,
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

    const { sheetUrl, zightUsername, zightPassword, submittedBy } = req.body;

    // Execute the script (synchronously for now - can be made async with job queue)
    console.log("⏳ Starting Zight automation...");
    const result = await executeZightScript(
      sheetUrl,
      zightUsername,
      zightPassword,
      submittedBy
    );

    if (result.success) {
      return res.json({
        success: true,
        message: "Zight automation completed successfully",
        jobId: result.jobId,
        campaignId: result.campaignId,
        campaignNumber: result.campaignNumber,
        logFile: result.logFile,
      });
    } else {
      return res.status(500).json({
        success: false,
        message: "Zight automation failed",
        error: result.error,
        jobId: result.jobId,
        campaignId: result.campaignId,
        campaignNumber: result.campaignNumber,
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

/**
 * Get all campaigns
 * GET /api/campaigns
 */
app.get("/api/campaigns", async (req, res) => {
  try {
    if (!isSupabaseEnabled()) {
      return res.status(503).json({
        success: false,
        error: "Supabase is not enabled. Check SUPABASE_URL and SUPABASE_ANON_KEY in .env",
      });
    }

    const { getCampaigns } = await import("./supabase-client.js");
    
    const status = req.query.status;
    const limit = req.query.limit ? parseInt(req.query.limit) : undefined;
    
    const campaigns = await getCampaigns({ status, limit });

    res.json({
      success: true,
      count: campaigns.length,
      campaigns,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * Get campaign statistics
 * GET /api/campaigns/:campaignNumber/stats
 */
app.get("/api/campaigns/:campaignNumber/stats", async (req, res) => {
  try {
    if (!isSupabaseEnabled()) {
      return res.status(503).json({
        success: false,
        error: "Supabase is not enabled. Check SUPABASE_URL and SUPABASE_ANON_KEY in .env",
      });
    }

    const { getCampaignStats } = await import("./supabase-client.js");
    const campaignNumber = parseInt(req.params.campaignNumber);

    const stats = await getCampaignStats(campaignNumber);

    if (!stats) {
      return res.status(404).json({
        success: false,
        error: `Campaign #${campaignNumber} not found`,
      });
    }

    res.json({
      success: true,
      stats,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * Get video shares for a campaign
 * GET /api/campaigns/:campaignId/shares
 */
app.get("/api/campaigns/:campaignId/shares", async (req, res) => {
  try {
    if (!isSupabaseEnabled()) {
      return res.status(503).json({
        success: false,
        error: "Supabase is not enabled. Check SUPABASE_URL and SUPABASE_ANON_KEY in .env",
      });
    }

    const { getVideoShares } = await import("./supabase-client.js");
    const { campaignId } = req.params;

    const shares = await getVideoShares(campaignId);

    res.json({
      success: true,
      count: shares.length,
      shares,
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
  console.log(`💾 Supabase: ${isSupabaseEnabled() ? "Enabled" : "Disabled"}`);
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

