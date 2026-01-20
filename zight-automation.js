// ==============================
// ZIGHT Automation - Browserbase + Playwright
// Runs locally via Cursor/Node.js
// ==============================

import { chromium } from "playwright";
import Browserbase from "@browserbasehq/sdk";
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import fs from "fs";
import {
  logVideoSharesBatch,
  updateCampaignLeads,
  isSupabaseEnabled,
} from "./supabase-client.js";

// Load environment variables
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: join(__dirname, ".env") });

// ========== CONFIGURATION ==========
const CONFIG = {
  // Browserbase
  browserbaseEnabled: process.env.BROWSERBASE_ENABLED !== "false",
  browserbaseApiKey: process.env.BROWSERBASE_API_KEY,
  browserbaseProjectId: process.env.BROWSERBASE_PROJECT_ID,

  // Zight
  accounts: [
    {
      username: process.env.ZIGHT_USERNAME || "daniel@carrotsnotsticks.com",
      password: process.env.ZIGHT_PASSWORD || "Carrotsnotsticks1",
    },
  ],

  // URLs
  urls: {
    login: "https://share.zight.com/login",
    dashboard: "https://share.zight.com/dashboard",
  },

  // Google Sheet
  sheetSpreadsheetId:
    process.env.SHEET_SPREADSHEET_ID ||
    "1KjLsWGHVfe_opY2NZC8ggf18NPSZuR7FFk20pTAQ1bE",
  sheetGid: process.env.SHEET_GID || "0",
  sheetColumnName: process.env.SHEET_COLUMN_NAME || "Email",

  // Other
  batchSize: parseInt(process.env.BATCH_SIZE) || 1,
  headless: process.env.HEADLESS === "true",

  // Campaign tracking (from webhook)
  campaignId: process.env.CAMPAIGN_ID || null,
  campaignNumber: process.env.CAMPAIGN_NUMBER || null,
};

// ========== HELPERS ==========
function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

async function wait(page, ms) {
  await page.waitForTimeout(ms).catch(() => {});
}

async function waitIdle(page, timeout = 45000) {
  await page.waitForLoadState("networkidle", { timeout }).catch(() => {});
}

async function screenshot(page, name) {
  // Screenshots disabled for production - enable only for debugging
  // Uncomment below to enable screenshots:
  /*
  try {
    const screenshotsDir = join(__dirname, "screenshots");
    if (!fs.existsSync(screenshotsDir)) {
      fs.mkdirSync(screenshotsDir, { recursive: true });
    }
    const filepath = join(screenshotsDir, name);
    await page.screenshot({ path: filepath, fullPage: true });
    console.log("🖼️ Screenshot:", filepath);
  } catch (err) {
    console.log("⚠️ Could not take screenshot:", err.message);
  }
  */
}

function safeName(s) {
  return String(s).replace(/[^a-z0-9]/gi, "_");
}

function normalizeEmail(s) {
  const v = String(s || "")
    .trim()
    .toLowerCase();
  if (!v) return "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return "";
  return v;
}

function isOnDashboardUrl(url) {
  return String(url || "").includes("/dashboard");
}

async function ensureOnDashboard(page) {
  if (!isOnDashboardUrl(page.url())) {
    await page.goto(CONFIG.urls.dashboard, { waitUntil: "domcontentloaded" });
    await wait(page, 1200);
  }
}

async function waitForFilePageFromDashboard(page, timeoutMs = 20000) {
  await page
    .waitForURL(
      (u) => {
        const url = String(u);
        if (!url.startsWith("http")) return false;
        if (url.includes("/dashboard")) return false;
        if (url.includes("/login")) return false;

        try {
          const parsed = new URL(url);
          const segs = parsed.pathname.split("/").filter(Boolean);
          return segs.length === 1 && /^[A-Za-z0-9_-]{5,}$/.test(segs[0]);
        } catch {
          return false;
        }
      },
      { timeout: timeoutMs }
    )
    .catch(() => {});
}

// Close popups/modals that block clicks
async function closePopupsIfAny(page) {
  for (let pass = 1; pass <= 3; pass++) {
    const dialogs = page.locator(
      '[role="dialog"], .modal, [data-testid*="modal" i], [data-testid*="dialog" i]'
    );
    const count = await dialogs.count().catch(() => 0);
    if (!count) return;

    console.log(
      `🧹 Detected modal/dialog (${count}). Closing... (attempt ${pass})`
    );

    const dialog = dialogs.first();
    const closeCandidates = [
      dialog.getByRole("button", {
        name: /close|dismiss|got it|ok|okay|continue/i,
      }),
      dialog.locator('[aria-label*="close" i]'),
      dialog.locator('button:has-text("×")'),
      dialog.locator('button:has-text("Close")'),
      dialog.locator('button:has-text("Got it")'),
      dialog.locator('button:has-text("OK")'),
      dialog.locator('button:has-text("Okay")'),
      dialog.locator("button").filter({ has: dialog.locator("svg") }).first(),
    ];

    let closed = false;
    for (const c of closeCandidates) {
      try {
        if ((await c.count()) > 0) {
          await c.first().click({ timeout: 3000 }).catch(() => {});
          await wait(page, 350);
          closed = true;
          break;
        }
      } catch {}
    }

    if (!closed) {
      await page.keyboard.press("Escape").catch(() => {});
      await wait(page, 350);
    }

    const remaining = await dialogs.count().catch(() => 0);
    if (!remaining) return;

    if (pass === 3) {
      console.log("🧨 Last resort: removing overlays via DOM");
      await page
        .evaluate(() => {
          const selectors = [
            '[role="dialog"]',
            ".modal",
            ".modal-backdrop",
            '[class*="backdrop" i]',
          ];
          for (const sel of selectors) {
            document.querySelectorAll(sel).forEach((el) => el.remove());
          }
          document.body.style.overflow = "auto";
          document.documentElement.style.overflow = "auto";
        })
        .catch(() => {});
      await wait(page, 250);
    }
  }
}

// ========== GOOGLE SHEET (PUBLIC CSV) ==========
// Uses native Node.js fetch (more reliable than using the browser)
async function readEmailsFromPublicSheet() {
  const csvUrl = `https://docs.google.com/spreadsheets/d/${CONFIG.sheetSpreadsheetId}/export?format=csv&gid=${CONFIG.sheetGid}`;
  console.log("📄 Fetching sheet CSV:", csvUrl);

  let csv = "";

  try {
    const response = await fetch(csvUrl, {
      method: "GET",
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      },
      redirect: "follow",
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    csv = await response.text();
  } catch (err) {
    console.log("⚠️ Error fetching CSV:", err.message);
  }

  if (!csv || !csv.trim()) {
    throw new Error(
      "CSV fetch returned empty. Check if the sheet is PUBLIC and the gid is correct."
    );
  }

  console.log(`📥 CSV fetched successfully (${csv.length} characters)`);

  // Minimal CSV parsing (supports commas within quotes)
  const lines = csv.split(/\r?\n/).filter((l) => l && l.trim().length > 0);
  if (lines.length < 2) {
    console.log("⚠️ Sheet has no data rows (only headers or empty)");
    return [];
  }

  const parseLine = (line) => {
    const out = [];
    let cur = "";
    let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') {
        inQ = !inQ;
      } else if (ch === "," && !inQ) {
        out.push(cur);
        cur = "";
      } else {
        cur += ch;
      }
    }
    out.push(cur);
    return out.map((x) => x.trim());
  };

  const headers = parseLine(lines[0]);
  console.log(`📊 Sheet headers: ${headers.join(", ")}`);
  console.log(`🔍 Looking for column: "${CONFIG.sheetColumnName}"`);
  
  const idx = headers.findIndex(
    (h) => h.trim().toLowerCase() === CONFIG.sheetColumnName.toLowerCase()
  );

  if (idx === -1) {
    throw new Error(
      `Column "${CONFIG.sheetColumnName}" not found. Headers: ${headers.join(", ")}`
    );
  }

  console.log(`✅ Found column "${CONFIG.sheetColumnName}" at index ${idx}`);

  const emails = [];
  for (let i = 1; i < lines.length; i++) {
    const row = parseLine(lines[i]);
    const raw = row[idx] ?? "";
    const em = normalizeEmail(raw);
    if (em) {
      emails.push(em);
    } else if (raw && raw.trim()) {
      console.log(`⚠️ Row ${i}: Invalid email format: "${raw}"`);
    }
  }

  console.log(`📧 Found ${emails.length} valid emails (before deduplication)`);

  // Remove duplicates while preserving order
  const seen = new Set();
  const deduped = [];
  for (const e of emails) {
    if (!seen.has(e)) {
      seen.add(e);
      deduped.push(e);
    }
  }

  console.log(`✅ Loaded ${deduped.length} unique emails from sheet`);
  if (deduped.length > 0) {
    console.log(`📋 Sample emails: ${deduped.slice(0, 3).join(", ")}${deduped.length > 3 ? "..." : ""}`);
  }
  
  return deduped;
}

// ========== LOGIN ==========
async function login(page, account) {
  console.log(`\n=== LOGIN: ${account.username} ===`);

  await page.goto(CONFIG.urls.login, { waitUntil: "domcontentloaded" });
  await wait(page, 800);

  await page.locator('input[type="email"]').first().fill(account.username);
  await page.locator('input[type="password"]').first().fill(account.password);

  const submitCandidates = [
    page.locator('button[type="submit"]'),
    page.getByRole("button", {
      name: /log\s*in|login|sign\s*in|continue|next/i,
    }),
    page.locator('input[type="submit"]'),
  ];

  let submitted = false;
  for (const loc of submitCandidates) {
    try {
      if ((await loc.count()) > 0) {
        await loc.first().click({ timeout: 15000 });
        submitted = true;
        break;
      }
    } catch {}
  }

  if (!submitted) {
    await page
      .locator('input[type="password"]')
      .first()
      .press("Enter")
      .catch(() => {});
  }

  await waitIdle(page);
  await wait(page, 800);

  await page.goto(CONFIG.urls.dashboard, { waitUntil: "domcontentloaded" });
  await wait(page, 1500);
  await waitIdle(page);

  console.log("✅ On:", page.url());
}

// ========== OPEN FILE ==========
async function openOnlyFileFromDashboard(page) {
  console.log("📁 Opening the ONLY file from dashboard...");

  await ensureOnDashboard(page);
  await wait(page, 800);

  console.log("🔍 Looking for first file (item-card-0) on dashboard...");
  await page
    .locator('#items.zt-grid-view .zt-dashboard-card [data-testid="item-card-0"]')
    .first()
    .waitFor({ timeout: 30000 })
    .catch(async () => {
      await screenshot(page, "debug_no_items_grid.png");
      throw new Error(
        "Could not find #items grid / item-card-0 on dashboard."
      );
    });

  console.log("✅ Found first file on dashboard");

  const startUrl = page.url();
  const viewerLink = page
    .locator('#items a[data-testid="item-viewer-link-0"]')
    .first();
  const thumbLink = page
    .locator('#items a.zt-thumbnail-link[data-testid="item-viewer-link-0"]')
    .first();

  let href = null;
  try {
    href = await viewerLink.getAttribute("href");
  } catch {}
  if (!href) {
    try {
      href = await thumbLink.getAttribute("href");
    } catch {}
  }

  console.log(`🔗 File link: ${href || "(not found)"}`);
  console.log("🖱️ Attempting to click file to open it...");

  await viewerLink.click({ timeout: 15000 }).catch(() => {});
  await wait(page, 600);

  if (isOnDashboardUrl(page.url()) || page.url() === startUrl) {
    console.log("⚠️ First click didn't work, trying thumbnail link...");
    await thumbLink.click({ timeout: 15000 }).catch(() => {});
    await wait(page, 600);
  }

  if (isOnDashboardUrl(page.url()) || page.url() === startUrl) {
    if (href && href.startsWith("/")) {
      console.log("⚠️ Clicks didn't work, navigating directly to file URL...");
      await page.goto(`https://share.zight.com${href}`, {
        waitUntil: "domcontentloaded",
      });
    }
  }

  await waitForFilePageFromDashboard(page, 20000);
  await waitIdle(page);

  await closePopupsIfAny(page);
  console.log("✅ File page opened:", page.url());
}

// ========== SHARE FLOW ==========
async function openShareModal(page) {
  console.log("📤 Opening Share modal...");
  await closePopupsIfAny(page);

  const shareByTestId = page
    .locator('[data-testid="viewer-actions-share"]')
    .first();
  const shareByTextSpan = page
    .locator('a:has([data-testid="button-text"]:has-text("Share"))')
    .first();
  const shareAnyShare = page
    .locator('a:has-text("Share"), button:has-text("Share")')
    .first();

  const candidates = [shareByTestId, shareByTextSpan, shareAnyShare];

  let clicked = false;
  for (const loc of candidates) {
    try {
      if ((await loc.count()) > 0) {
        await loc.scrollIntoViewIfNeeded().catch(() => {});
        await wait(page, 200);
        await loc.click({ timeout: 8000 }).catch(() => {});
        await wait(page, 400);
        clicked = true;
        break;
      }
    } catch {}
  }

  if (!clicked) {
    await screenshot(page, "debug_no_share_button.png");
    throw new Error("Could not find/click Share button.");
  }

  const dialog = page.locator('[role="dialog"]').first();
  await dialog.waitFor({ timeout: 15000 }).catch(async () => {
    await screenshot(page, "debug_no_share_dialog.png");
    throw new Error("Share dialog did not appear after clicking Share.");
  });

  const addPeople = dialog
    .locator('input[placeholder*="Add People" i], [contenteditable="true"]')
    .first();
  await addPeople.waitFor({ timeout: 15000 }).catch(async () => {
    await screenshot(page, "debug_share_dialog_no_add_people.png");
    throw new Error(
      'Share dialog opened but "Add People" input was not found.'
    );
  });

  console.log("✅ Share modal opened");
}

async function findShareDialog(page) {
  const dialog = page.locator('[role="dialog"]').first();
  if ((await dialog.count()) > 0) return dialog;
  return page.locator("body");
}

async function findAddPeopleInput(dialog) {
  const candidates = [
    dialog.locator('input[placeholder*="Add People" i]').first(),
    dialog.locator('input[placeholder*="Add" i]').first(),
    dialog.locator('[contenteditable="true"]').first(),
  ];
  for (const c of candidates) {
    try {
      if ((await c.count()) > 0) return c;
    } catch {}
  }
  return null;
}

async function findSendButtonNearInput(dialog, input) {
  const ib = await input.boundingBox().catch(() => null);
  if (!ib) return null;

  const buttons = dialog.locator("button");
  const n = await buttons.count().catch(() => 0);
  if (!n) return null;

  let best = { idx: -1, score: Number.POSITIVE_INFINITY };
  for (let i = 0; i < n; i++) {
    const b = buttons.nth(i);
    const bb = await b.boundingBox().catch(() => null);
    if (!bb) continue;

    const centerY = bb.y + bb.height / 2;
    const inputCenterY = ib.y + ib.height / 2;

    const sameRow = Math.abs(centerY - inputCenterY) < Math.max(ib.height, 28);
    const toRight = bb.x > ib.x + ib.width * 0.7;
    if (!sameRow || !toRight) continue;

    const dx = Math.abs(bb.x - (ib.x + ib.width));
    if (dx < best.score) best = { idx: i, score: dx };
  }

  if (best.idx >= 0) return buttons.nth(best.idx);
  return null;
}

async function fillEmailsAndSend(page, batch, campaignId, zightAccount, googleSheetLink) {
  const emailCount = batch.length;
  const emailText = emailCount === 1 ? batch[0] : `${emailCount} emails`;
  console.log(`✉️ Sending: ${emailText}...`);

  const dialog = await findShareDialog(page);
  const input = await findAddPeopleInput(dialog);

  if (!input) {
    await screenshot(page, "debug_no_add_people_input.png");
    throw new Error('Could not find "Add People" input in share modal.');
  }

  await input.click().catch(() => {});
  await wait(page, 200);

  console.log(`📝 Adding email(s) to the input...`);
  for (const email of batch) {
    await page.keyboard.type(email, { delay: 10 }).catch(() => {});
    await page.keyboard.press("Enter").catch(() => {});
    await wait(page, 150);
  }
  console.log(`✅ Added: ${emailText}`);

  // Try to find the submit button - prioritize data-testid="submit" (it's a span, not a button!)
  console.log("🔍 Looking for submit button...");
  let sendBtn = dialog.locator('[data-testid="submit"]').first();
  
  // Check if found
  const submitCount = await sendBtn.count().catch(() => 0);
  if (submitCount > 0) {
    console.log("✅ Found submit button by data-testid='submit'");
  } else {
    console.log("⚠️ Submit button with data-testid not found, trying fallback methods...");
    // Fallback to old methods
    sendBtn = await findSendButtonNearInput(dialog, input);
    if (!sendBtn) {
      console.log("⚠️ Trying xpath fallback...");
      sendBtn = input.locator("xpath=following::button[1]");
    }
  }

  console.log("🖱️ Clicking submit button...");
  await sendBtn.click({ timeout: 15000 }).catch(async () => {
    await screenshot(page, "error_no_send_button.png");
    throw new Error("Could not click Send button.");
  });

  // Wait for Zight to process the share
  console.log("⏳ Waiting for Zight to process...");
  await wait(page, 3000);
  
  // Check specifically for "Cannot update invitations" error (appears in bottom-right toast)
  const cannotUpdateInvitations = page.locator('text=/Cannot update invitations/i').first();
  if (await cannotUpdateInvitations.count() > 0) {
    console.log("🚨 ERROR: Cannot update invitations - Share limit reached!");
    
    // Log failed shares to Supabase
    if (campaignId && isSupabaseEnabled()) {
      const failedShares = batch.map(email => ({
        campaignId,
        email,
        zightAccount,
        googleSheetLink,
        status: "failed",
        errorMessage: "Share limit reached (20 people max)",
      }));
      await logVideoSharesBatch(failedShares);
    }
    
    await screenshot(page, `error_cannot_update_invitations_${Date.now()}.png`);
    throw new Error("Cannot update invitations - Share limit reached (20 people max). Clear existing shares first.");
  }
  
  // Check for other error messages
  const errorSelectors = [
    'text=/error/i',
    'text=/failed/i',
    'text=/invalid/i',
    '[role="alert"]',
  ];
  
  let errorFound = false;
  let errorMessage = "";
  for (const selector of errorSelectors) {
    const errorEl = page.locator(selector).first();
    if (await errorEl.count() > 0) {
      const errorText = await errorEl.textContent().catch(() => '');
      if (errorText && !errorText.match(/Cannot update invitations/i)) {
        console.log(`❌ ERROR: ${errorText}`);
        errorMessage = errorText;
        await screenshot(page, `error_${Date.now()}.png`);
        errorFound = true;
      }
    }
  }
  
  if (errorFound) {
    // Log failed shares to Supabase
    if (campaignId && isSupabaseEnabled()) {
      const failedShares = batch.map(email => ({
        campaignId,
        email,
        zightAccount,
        googleSheetLink,
        status: "failed",
        errorMessage,
      }));
      await logVideoSharesBatch(failedShares);
    }
    
    throw new Error("Error detected after clicking submit button");
  }

  // Success! Log to Supabase
  if (campaignId && isSupabaseEnabled()) {
    const successfulShares = batch.map(email => ({
      campaignId,
      email,
      zightAccount,
      googleSheetLink,
      status: "sent",
    }));
    await logVideoSharesBatch(successfulShares);
    console.log(`💾 Logged ${batch.length} video share(s) to Supabase`);
  }

  await page.keyboard.press("Escape").catch(() => {});
  await wait(page, 500);

  console.log(`✅ Sent successfully: ${emailText}`);
}

// ========== CLEAR EXISTING SHARES ==========
async function clearExistingShares(page, force = false) {
  console.log(`🧹 Checking if we need to clear existing shares... ${force ? '(FORCED)' : ''}`);
  
  // Get the file ID from current URL
  const url = page.url();
  const fileIdMatch = url.match(/\/([a-zA-Z0-9]+)$/);
  if (!fileIdMatch) {
    console.log("⚠️ Could not extract file ID from URL, skipping clear");
    return;
  }
  
  const fileId = fileIdMatch[1];
  const apiUrl = `https://share.zight.com/api/v5/items/${fileId}`;
  
  try {
    // Fetch current shares via API
    const response = await page.evaluate(async (url) => {
      const res = await fetch(url);
      return res.json();
    }, apiUrl);
    
    const specificUsers = response?.data?.item?.attributes?.security?.specific_users || [];
    const count = specificUsers.length;
    
    console.log(`📊 Current shares: ${count} people`);
    
    // If force=true, always clear. Otherwise, only clear if >= 18 people
    const shouldClear = force || count >= 18;
    
    if (!shouldClear) {
      console.log(`✅ Only ${count} shares, no need to clear (limit is 20)`);
      return;
    }
    
    if (count === 0) {
      console.log("✅ No shares to clear");
      return;
    }
    
    console.log(`⚠️ ${count} people already shared! Clearing list...`);
    
    // Open share modal
    await openShareModal(page);
    
    const dialog = await findShareDialog(page);
    
    // Step 1: Click the dropdown button to open the menu
    console.log("🔽 Opening dropdown menu...");
    const dropdownButton = dialog.locator('[data-testid="viewer-share-who-is-viewing"]').first();
    if (await dropdownButton.count() === 0) {
      console.log("⚠️ Could not find dropdown button, skipping clear");
      await page.keyboard.press("Escape").catch(() => {});
      await wait(page, 500);
      return;
    }
    
    await dropdownButton.click({ timeout: 10000 }).catch(() => {});
    await wait(page, 1000);
    
    // Step 2: Click on "Only emailed people" option in the menu
    console.log("🔽 Selecting 'Only emailed people'...");
    const onlyEmailedOption = page.locator('[data-testid="menu-item-only-emailed-people"]').first();
    if (await onlyEmailedOption.count() === 0) {
      console.log("⚠️ Could not find 'Only emailed people' menu item, skipping clear");
      await page.keyboard.press("Escape").catch(() => {});
      await wait(page, 500);
      return;
    }
    
    await onlyEmailedOption.click({ timeout: 10000 }).catch(() => {});
    await wait(page, 1500);
    
    // Step 3: Find and click all remove buttons (× icons)
    console.log("❌ Removing all existing shares...");
    
    let removedCount = 0;
    const maxAttempts = 30; // Safety limit to prevent infinite loops
    
    // Keep clicking remove buttons until none are left (dynamic checking)
    while (removedCount < maxAttempts) {
      const removeButtons = page.locator('[data-testid="chips-cancel"]');
      const currentCount = await removeButtons.count();
      
      if (currentCount === 0) {
        console.log(`✅ All emails removed! (Total: ${removedCount})`);
        break;
      }
      
      // Click the first remove button
      const clicked = await removeButtons.first().click({ timeout: 5000 }).catch(() => false);
      
      if (!clicked) {
        console.log(`⚠️ Failed to click remove button #${removedCount + 1}, retrying...`);
        await wait(page, 500);
        continue;
      }
      
      removedCount++;
      console.log(`   Removed ${removedCount}/${currentCount}...`);
      
      // Wait for DOM to update before next click
      await wait(page, 500);
    }
    
    if (removedCount >= maxAttempts) {
      console.log(`⚠️ Reached max attempts (${maxAttempts}), stopping removal loop`);
    }
    
    await wait(page, 1000);
    
    // ⚠️ IMPORTANT: DO NOT switch back to "Anyone with the link can view"!
    // If we do, the emails remain in the API's "specific_users" list and still count toward the 20 limit.
    // We MUST stay in "Only emailed people" mode after clearing so the list is truly empty.
    
    console.log("✅ Staying in 'Only emailed people' mode (emails truly cleared)");
    
    // Close modal
    await page.keyboard.press("Escape").catch(() => {});
    await wait(page, 500);
    
    console.log("✅ Existing shares cleared!");
  } catch (error) {
    console.log(`⚠️ Could not check/clear shares: ${error.message}`);
  }
}

// ========== RUN FOR ACCOUNT ==========
async function runForAccount(page, account) {
  const campaignId = CONFIG.campaignId;
  const campaignNumber = CONFIG.campaignNumber;
  const googleSheetLink = `https://docs.google.com/spreadsheets/d/${CONFIG.sheetSpreadsheetId}/edit#gid=${CONFIG.sheetGid}`;
  
  // Log campaign info if available
  if (campaignNumber) {
    console.log(`📋 Campaign: #${campaignNumber} (ID: ${campaignId || 'N/A'})`);
  }

  // 1) Read emails from sheet (before login)
  const sheetEmails = await readEmailsFromPublicSheet();
  if (!sheetEmails.length) {
    console.log("⚠️ No emails found in sheet. Nothing to send.");
    return;
  }

  // Update total_leads in Supabase (if campaign exists)
  if (campaignId && isSupabaseEnabled()) {
    await updateCampaignLeads(campaignId, sheetEmails.length);
  }

  // 2) Login + open file
  await login(page, account);
  await openOnlyFileFromDashboard(page);

  // 3) ALWAYS clear existing shares at the start (fresh start every time)
  console.log("🧹 Clearing existing shares to start fresh...");
  await clearExistingShares(page, true); // force=true to always clear

  // 4) Process emails in batches of 20 (Zight's limit)
  // After every 20 emails, clear and continue with next batch
  const ZIGHT_LIMIT = 20;
  const totalEmails = sheetEmails.length;
  const superBatches = chunk(sheetEmails, ZIGHT_LIMIT); // Split into groups of 20
  
  console.log(`📦 Processing ${totalEmails} email${totalEmails > 1 ? 's' : ''}`);
  console.log(`📊 This will be done in ${superBatches.length} super-batch${superBatches.length > 1 ? 'es' : ''} of up to ${ZIGHT_LIMIT} emails each`);
  
  if (isSupabaseEnabled()) {
    console.log(`💾 Supabase logging: Enabled`);
  } else {
    console.log(`⚠️ Supabase logging: Disabled (no credentials in .env)`);
  }

  for (let superBatchIdx = 0; superBatchIdx < superBatches.length; superBatchIdx++) {
    const superBatch = superBatches[superBatchIdx];
    
    console.log(`\n📦 === Super-Batch ${superBatchIdx + 1}/${superBatches.length} (${superBatch.length} emails) ===`);
    
    // Process this super-batch in small batches (1 at a time for reliability)
    const batches = chunk(superBatch, CONFIG.batchSize);
    
    for (let i = 0; i < batches.length; i++) {
      const emailNum = superBatchIdx * ZIGHT_LIMIT + i + 1;
      console.log(`\n➡️ Email ${emailNum}/${totalEmails}`);
      await openShareModal(page);
      await fillEmailsAndSend(page, batches[i], campaignId, account.username, googleSheetLink);
      await wait(page, 500);
    }
    
    // If there are more super-batches to process, clear the list for the next batch
    if (superBatchIdx < superBatches.length - 1) {
      console.log(`\n🔄 Super-batch ${superBatchIdx + 1} complete. Clearing for next batch...`);
      await clearExistingShares(page, true); // force=true
    }
  }

  console.log(`\n🏁 Finished: ${account.username} - Sent to ${totalEmails} email${totalEmails > 1 ? 's' : ''}`);
  
  if (campaignNumber) {
    console.log(`📊 Campaign #${campaignNumber} completed. Check Supabase for detailed stats.`);
  }
}

// ========== CREATE BROWSER ==========
async function createBrowser() {
  if (CONFIG.browserbaseEnabled) {
    // Use Browserbase
    if (!CONFIG.browserbaseApiKey || !CONFIG.browserbaseProjectId) {
      throw new Error(
        "BROWSERBASE_API_KEY and BROWSERBASE_PROJECT_ID are required when BROWSERBASE_ENABLED=true"
      );
    }

    console.log("🌐 Connecting to Browserbase...");

    const bb = new Browserbase({
      apiKey: CONFIG.browserbaseApiKey,
    });

    // Create session
    const session = await bb.sessions.create({
      projectId: CONFIG.browserbaseProjectId,
    });

    console.log(`📍 Session created: ${session.id}`);

    // Connect via CDP
    const browser = await chromium.connectOverCDP(session.connectUrl);

    return {
      browser,
      cleanup: async () => {
        console.log("🧹 Closing Browserbase session...");
        await browser.close();
      },
    };
  } else {
    // Use local Playwright
    console.log("🖥️ Starting local Playwright...");

    const browser = await chromium.launch({
      headless: CONFIG.headless,
    });

    return {
      browser,
      cleanup: async () => {
        console.log("🧹 Closing local browser...");
        await browser.close();
      },
    };
  }
}

// ========== MAIN ==========
async function main() {
  console.log("▶ Starting Zight automation...");
  console.log(
    `📋 Mode: ${CONFIG.browserbaseEnabled ? "Browserbase Cloud" : "Playwright Local"}`
  );

  const { browser, cleanup } = await createBrowser();

  try {
    const context = browser.contexts()[0] || (await browser.newContext());
    const page = await context.newPage();

    for (const acc of CONFIG.accounts) {
      try {
        await runForAccount(page, acc);
      } catch (e) {
        console.log("🔥 Error:", e?.message || e);
        await screenshot(page, `debug_${safeName(acc.username)}.png`);
        throw e;
      }
    }

    console.log("✅ ALL DONE");
  } finally {
    await cleanup();
  }
}

// Run
main().catch((err) => {
  console.error("❌ Fatal error:", err);
  process.exit(1);
});

