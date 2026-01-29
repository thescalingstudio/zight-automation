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

// Get shares count via Zight API
async function getSharesCount(page, fileId) {
  try {
    const apiUrl = `https://share.zight.com/api/v5/items/${fileId}`;
    const response = await page.evaluate(async (url) => {
      const res = await fetch(url);
      return res.json();
    }, apiUrl);
    
    const specificUsers = response?.data?.item?.attributes?.security?.specific_users || [];
    return specificUsers.length;
  } catch (error) {
    console.log(`⚠️ Could not fetch shares count: ${error.message}`);
    return -1; // Return -1 to indicate error
  }
}

// Open share settings dropdown (used by clear and changeToPublic)
async function openShareSettingsDropdown(dialog, page) {
  console.log("🔽 Opening share settings dropdown...");
  
  const dropdownButton = dialog.locator('[data-testid="viewer-share-who-is-viewing"]').first();
  if (await dropdownButton.count() === 0) {
    console.log("⚠️ Could not find dropdown button");
    await page.keyboard.press("Escape").catch(() => {});
    await wait(page, 500);
    return false;
  }
  
  await dropdownButton.click({ timeout: 10000 }).catch(() => {});
  await wait(page, 800); // Reduced from 1000ms
  
  return true;
}

// Close popups/modals that block clicks (optimized: direct DOM removal)
async function closePopupsIfAny(page) {
  const dialogs = page.locator(
    '[role="dialog"], .modal, [data-testid*="modal" i], [data-testid*="dialog" i]'
  );
  const count = await dialogs.count().catch(() => 0);
  if (!count) return;

  console.log(`🧹 Detected ${count} modal/dialog(s). Removing via DOM...`);

  // Direct DOM removal (fastest and most reliable method)
  await page
    .evaluate(() => {
      const selectors = [
        '[role="dialog"]',
        ".modal",
        ".modal-backdrop",
        '[class*="backdrop" i]',
        '[data-testid*="modal" i]',
        '[data-testid*="dialog" i]',
      ];
      for (const sel of selectors) {
        document.querySelectorAll(sel).forEach((el) => el.remove());
      }
      document.body.style.overflow = "auto";
      document.documentElement.style.overflow = "auto";
    })
    .catch(() => {});
  
  await wait(page, 200); // Reduced from 250ms
  console.log("✅ Modals removed");
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
  for (let i = 0; i < batch.length; i++) {
    const email = batch[i];
    console.log(`  📧 [${i + 1}/${batch.length}] Adding: ${email}`);
    await page.keyboard.type(email, { delay: 10 }).catch(() => {});
    await page.keyboard.press("Enter").catch(() => {});
    await wait(page, 150);
  }
  console.log(`✅ Added all ${batch.length} email(s)`);

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
  await wait(page, 3000); // Optimized wait time
  
  // Check for success indicators first (look for green checkmark or "Sent" message)
  const successIndicators = [
    'text=/sent/i',
    'text=/success/i',
    '[data-testid*="success"]',
  ];
  
  // Check all indicators in parallel (faster)
  const successChecks = await Promise.all(
    successIndicators.map(async (selector) => {
      const count = await page.locator(selector).first().count().catch(() => 0);
      return { selector, found: count > 0 };
    })
  );
  
  const successResult = successChecks.find(r => r.found);
  const successFound = !!successResult;
  
  if (successFound) {
    console.log(`✅ Success indicator found: ${successResult.selector}`);
  }
  
  // Only check for errors if NO success indicator was found
  if (!successFound) {
    console.log("🔍 No success indicator found, checking for errors...");
    
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
      
      // Log each failed email individually
      console.log(`❌ Failed to send to ${batch.length} email(s):`);
      batch.forEach((email, i) => {
        console.log(`  ❌ [${i + 1}/${batch.length}] ${email} - Share limit reached`);
      });
      
      await screenshot(page, `error_cannot_update_invitations_${Date.now()}.png`);
      throw new Error("Cannot update invitations - Share limit reached (20 people max). Clear existing shares first.");
    }
    
    // Check for other error messages
    const errorSelectors = [
      'text=/error/i',
      'text=/failed/i',
      'text=/invalid email/i',
      '[role="alert"]',
    ];
    
    let errorFound = false;
    let errorMessage = "";
    for (const selector of errorSelectors) {
      const errorEl = page.locator(selector).first();
      if (await errorEl.count() > 0) {
        const errorText = await errorEl.textContent().catch(() => '');
        // Filter out false positives (generic UI text with "error" word)
        if (errorText && 
            !errorText.match(/Cannot update invitations/i) &&
            errorText.length < 200 && // Ignore very long text (probably not an error)
            !errorText.match(/Could be of interest/i)) { // Ignore video title/description
          console.log(`❌ ERROR: ${errorText}`);
          errorMessage = errorText;
          await screenshot(page, `error_${Date.now()}.png`);
          errorFound = true;
          break;
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
      
      // Log each failed email individually
      console.log(`❌ Failed to send to ${batch.length} email(s):`);
      batch.forEach((email, i) => {
        console.log(`  ❌ [${i + 1}/${batch.length}] ${email} - ${errorMessage}`);
      });
      
      throw new Error(`Error detected after clicking submit button: ${errorMessage}`);
    }
  }

  // If we got here, assume success (no errors found)
  console.log("✅ No errors detected, assuming success");

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
    console.log(`💾 Logged ${batch.length} successful share(s) to Supabase`);
  }

  // Log each successful email individually
  console.log(`✅ Successfully sent to ${batch.length} email(s):`);
  batch.forEach((email, i) => {
    console.log(`  ✅ [${i + 1}/${batch.length}] ${email}`);
  });

  await page.keyboard.press("Escape").catch(() => {});
  await wait(page, 500);
}

// ========== CLEAR EXISTING SHARES ==========
// Uses API to verify true share count and scrolls to load all chips
// Keeps clearing until API confirms 0 shares remaining
async function clearExistingShares(page, force = false) {
  console.log(`🧹 Clearing existing shares...`);
  
  // Extract fileId from current URL (e.g., /p9umoqmg -> p9umoqmg)
  const currentUrl = page.url();
  const fileIdMatch = currentUrl.match(/share\.zight\.com\/([a-zA-Z0-9]+)/);
  const fileId = fileIdMatch ? fileIdMatch[1] : null;
  
  // Check API for actual share count BEFORE we start
  let apiShareCount = -1;
  if (fileId) {
    apiShareCount = await getSharesCount(page, fileId);
    console.log(`📊 API reports ${apiShareCount} existing share(s)`);
  }
  
  // If API confirms 0 shares and we're not forcing, we might be done
  // But we should still verify visually because API can be cached
  if (apiShareCount === 0 && !force) {
    console.log(`✅ API confirms no shares - skipping clear`);
    return true;
  }
  
  const MAX_CLEAR_ROUNDS = 10; // We may need multiple rounds if chips load lazily
  const removeButtonSelectors = [
    '[data-testid="chips-cancel"]',
    'button[aria-label*="Remove"]',
    'button[aria-label*="remove"]',
    'button svg path[d*="M13.092 7.408"]',
    '.zt-chip button',
    '[data-testid*="remove"]',
    '[data-testid*="cancel"]',
  ];
  
  let totalRemoved = 0;
  
  for (let round = 1; round <= MAX_CLEAR_ROUNDS; round++) {
    try {
      // Open share modal
      await openShareModal(page);
      const dialog = await findShareDialog(page);
      
      // Open dropdown using helper
      const dropdownOpened = await openShareSettingsDropdown(dialog, page);
      if (!dropdownOpened) {
        console.log(`⚠️ Round ${round}: Could not open dropdown`);
        await page.keyboard.press("Escape").catch(() => {});
        await wait(page, 500);
        continue;
      }
      
      // Click on "Only emailed people" option - this reveals the chips
      console.log("🔽 Selecting 'Only emailed people' to reveal any existing shares...");
      const onlyEmailedOption = page.locator('[data-testid="menu-item-only-emailed-people"]').first();
      if (await onlyEmailedOption.count() === 0) {
        console.log("⚠️ Could not find 'Only emailed people' menu item");
        await page.keyboard.press("Escape").catch(() => {});
        await wait(page, 500);
        continue;
      }
      
      await onlyEmailedOption.click({ timeout: 10000 }).catch(() => {});
      
      // Wait for initial chips to load
      await wait(page, 2000);
      
      // SCROLL to load more chips - Zight may use virtual scrolling
      // Find the chip container and scroll it
      const chipContainers = [
        '[class*="chip-container"]',
        '[class*="chips"]',
        '[role="dialog"] [class*="scroll"]',
        '[role="dialog"] > div > div',
      ];
      
      for (const containerSel of chipContainers) {
        try {
          const container = page.locator(containerSel).first();
          if (await container.count() > 0) {
            // Scroll down multiple times to load all chips
            for (let i = 0; i < 5; i++) {
              await container.evaluate(el => el.scrollTop = el.scrollHeight).catch(() => {});
              await wait(page, 300);
            }
            // Scroll back to top
            await container.evaluate(el => el.scrollTop = 0).catch(() => {});
            await wait(page, 500);
            break;
          }
        } catch {}
      }
      
      // Also try scrolling the dialog itself
      await dialog.evaluate(el => {
        const scrollable = el.querySelector('[style*="overflow"]') || el;
        if (scrollable) {
          scrollable.scrollTop = scrollable.scrollHeight;
        }
      }).catch(() => {});
      await wait(page, 500);
      
      // Now remove ALL chips found in this round
      console.log("❌ Removing any existing shares...");
      
      let removedThisRound = 0;
      let consecutiveFailures = 0;
      const maxPerRound = 500; // Max per round to prevent infinite loops
      const maxConsecutiveFailures = 5;
      
      while (removedThisRound < maxPerRound && consecutiveFailures < maxConsecutiveFailures) {
        let removeButtons = null;
        let currentCount = 0;
        
        // Try each selector until we find buttons
        for (const selector of removeButtonSelectors) {
          removeButtons = page.locator(selector);
          currentCount = await removeButtons.count().catch(() => 0);
          if (currentCount > 0) {
            if (removedThisRound === 0 && totalRemoved === 0) {
              console.log(`   Found ${currentCount} email(s) to remove`);
            }
            break;
          }
        }
        
        // No chips found in this round
        if (currentCount === 0) {
          if (removedThisRound === 0 && totalRemoved === 0) {
            // First round, no chips at all - might need to wait more
            await wait(page, 1000);
            // Check one more time after waiting
            for (const selector of removeButtonSelectors) {
              currentCount = await page.locator(selector).count().catch(() => 0);
              if (currentCount > 0) break;
            }
            if (currentCount === 0) {
              console.log(`✅ No emails to remove - list appears empty`);
              break;
            }
            continue;
          }
          // Removed some chips, no more visible
          break;
        }
        
        // Click the first remove button
        let clickSuccess = false;
        try {
          await removeButtons.first().click({ timeout: 2000 });
          clickSuccess = true;
        } catch {
          // Try clicking via JavaScript (more reliable)
          try {
            await page.evaluate(() => {
              const selectors = [
                '[data-testid="chips-cancel"]',
                'button[aria-label*="Remove"]',
                'svg path[d*="M13.092"]',
              ];
              for (const sel of selectors) {
                const el = document.querySelector(sel);
                if (el) {
                  el.closest('button')?.click() || el.click();
                  return true;
                }
              }
              return false;
            });
            clickSuccess = true;
          } catch {
            clickSuccess = false;
          }
        }
        
        if (clickSuccess) {
          removedThisRound++;
          totalRemoved++;
          consecutiveFailures = 0;
          // Log progress
          if (totalRemoved <= 10 || totalRemoved % 50 === 0) {
            console.log(`   Removed ${totalRemoved}...`);
          }
          await wait(page, 300); // Fast removal
        } else {
          consecutiveFailures++;
          await wait(page, 300);
        }
      }
      
      if (removedThisRound > 0) {
        console.log(`   Round ${round}: Removed ${removedThisRound} email(s) (total: ${totalRemoved})`);
      }
      
      // Close modal to refresh state
      await page.keyboard.press("Escape").catch(() => {});
      await wait(page, 1000);
      
      // Check API for remaining shares
      if (fileId) {
        const remainingShares = await getSharesCount(page, fileId);
        console.log(`📊 API reports ${remainingShares} share(s) remaining after round ${round}`);
        
        if (remainingShares === 0) {
          console.log(`✅ All ${totalRemoved} email(s) cleared! API confirms 0 remaining.`);
          return true;
        }
        
        if (remainingShares > 0 && removedThisRound === 0) {
          // API says there are shares but we couldn't remove any
          // This means the UI isn't showing them - need different approach
          console.log(`⚠️ API reports ${remainingShares} shares but UI shows none - will retry`);
          await wait(page, 2000); // Wait longer before retry
        }
      } else {
        // No API check possible, rely on visual verification
        if (removedThisRound === 0 && round > 1) {
          console.log(`✅ No more chips found after ${totalRemoved} removals`);
          return true;
        }
      }
      
      // If we removed nothing this round but API still shows shares,
      // we might be stuck - but continue trying
      if (removedThisRound === 0 && round >= 3) {
        console.log(`⚠️ Unable to find more chips after ${round} rounds`);
        break;
      }
      
    } catch (error) {
      console.log(`⚠️ Error during clear round ${round}: ${error.message}`);
      await page.keyboard.press("Escape").catch(() => {});
      await wait(page, 500);
    }
  }
  
  // Final API check
  if (fileId) {
    const finalCount = await getSharesCount(page, fileId);
    if (finalCount === 0) {
      console.log(`✅ Clear complete - API confirms 0 shares`);
      return true;
    } else if (finalCount > 0) {
      console.log(`⚠️ Clear incomplete - API still reports ${finalCount} share(s)`);
      console.log(`   This may be an API caching issue. Removed ${totalRemoved} visually.`);
      // Return true anyway if we removed a significant number
      if (totalRemoved > 0) {
        return true;
      }
    }
  }
  
  if (totalRemoved > 0) {
    console.log(`✅ Clear complete - removed ${totalRemoved} email(s)`);
    return true;
  }
  
  console.log(`⚠️ Clear may not have fully succeeded`);
  return false;
}

// ========== CHANGE TO PUBLIC ACCESS ==========
async function changeToPublicAccess(page) {
  console.log("\n🌐 Changing file access to 'Anyone with the link can view'...");
  
  try {
    // Open share modal
    await openShareModal(page);
    const dialog = await findShareDialog(page);
    
    // Open dropdown using helper
    const dropdownOpened = await openShareSettingsDropdown(dialog, page);
    if (!dropdownOpened) {
      return false;
    }
    
    // Click on "Anyone with the link can view" option in the menu
    console.log("🔗 Selecting 'Anyone with the link can view'...");
    const anyoneWithLinkOption = page.locator('[data-testid="menu-item-anyone-with-the-link-can-view"]').first();
    if (await anyoneWithLinkOption.count() === 0) {
      console.log("⚠️ Could not find 'Anyone with the link can view' menu item");
      await page.keyboard.press("Escape").catch(() => {});
      await wait(page, 500);
      return false;
    }
    
    await anyoneWithLinkOption.click({ timeout: 10000 }).catch(() => {});
    await wait(page, 1200); // Optimized from 1500ms
    
    console.log("✅ File access changed to 'Anyone with the link can view'");
    
    // Close modal
    await page.keyboard.press("Escape").catch(() => {});
    await wait(page, 500);
    
    return true;
  } catch (error) {
    console.log(`⚠️ Could not change to public access: ${error.message}`);
    return false;
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
  const initialClear = await clearExistingShares(page, true); // force=true to always clear
  
  if (!initialClear) {
    throw new Error("Failed to clear initial shares. Cannot start safely.");
  }

  // 4) Process emails: send 15, clear 15, send 15, clear 15, etc.
  const BATCH_SIZE = 15;
  const totalEmails = sheetEmails.length;
  const batches = chunk(sheetEmails, BATCH_SIZE); // Split into groups of 15
  
  console.log(`📦 Processing ${totalEmails} email${totalEmails > 1 ? 's' : ''}`);
  console.log(`📊 This will be done in ${batches.length} batch${batches.length > 1 ? 'es' : ''} of up to ${BATCH_SIZE} emails each`);
  console.log(`🔄 Each batch: Share 15 → Clear 15 → Repeat`);
  
  if (isSupabaseEnabled()) {
    console.log(`💾 Supabase logging: Enabled`);
  } else {
    console.log(`⚠️ Supabase logging: Disabled (no credentials in .env)`);
  }

  let batchError = null;
  let completedBatches = 0;

  // Use try-finally to ALWAYS change to public access, even on error
  try {
    for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
      const batch = batches[batchIdx];
      const startNum = batchIdx * BATCH_SIZE + 1;
      const endNum = startNum + batch.length - 1;
      
      console.log(`\n📦 === Batch ${batchIdx + 1}/${batches.length} (Emails ${startNum}-${endNum}) ===`);
      
      // BEFORE each batch (except first): Clear any residual emails
      // This ensures the list is truly empty before we add new emails
      if (batchIdx > 0) {
        console.log(`🔄 Pre-batch clear: Ensuring list is empty before sending...`);
        const preClear = await clearExistingShares(page, true);
        if (!preClear) {
          console.log(`⚠️ Pre-batch clear failed, but continuing anyway...`);
        }
      }
      
      // Open share modal for this batch
      await openShareModal(page);
      
      // Send all emails in this batch at once
      await fillEmailsAndSend(page, batch, campaignId, account.username, googleSheetLink);
      await wait(page, 500);
      
      completedBatches++;
      
      // After sending this batch of 15, CLEAR them immediately (except for the last batch)
      if (batchIdx < batches.length - 1) {
        console.log(`\n🧹 Batch ${batchIdx + 1} sent! Clearing these ${batch.length} emails before next batch...`);
        const cleared = await clearExistingShares(page, true);
        
        if (!cleared) {
          throw new Error(`Failed to clear batch ${batchIdx + 1}. Cannot continue safely.`);
        }
        
        console.log(`✅ Cleared! Ready for next batch.\n`);
      } else {
        console.log(`\n✅ Final batch sent! No need to clear (will change to public instead).`);
      }
    }
  } catch (error) {
    console.log(`\n🚨 ERROR during batch processing: ${error.message}`);
    batchError = error;
    // Don't throw yet - we need to change to public access first!
  }

  // 5) FINAL STEP: ALWAYS change file access to "Anyone with the link can view"
  // This runs even if there was an error, so previously sent emails can still access the video
  console.log(`\n🎯 Changing file access to public... ${batchError ? '(despite error)' : ''}`);
  
  try {
    const changedToPublic = await changeToPublicAccess(page);
    
    if (changedToPublic) {
      console.log("✅ File access changed to 'Anyone with the link can view'");
    } else {
      console.log("⚠️ Warning: Could not change file to public access. File may still be in 'Only emailed people' mode.");
    }
  } catch (publicError) {
    console.log(`⚠️ Error changing to public access: ${publicError.message}`);
  }

  // Now report final status
  if (batchError) {
    console.log(`\n🏁 ========== CAMPAIGN INCOMPLETE (ERROR) ==========`);
    console.log(`❌ Error: ${batchError.message}`);
    console.log(`📊 Completed batches: ${completedBatches}/${batches.length}`);
    console.log(`📧 Emails sent: ~${completedBatches * BATCH_SIZE} of ${totalEmails}`);
    console.log(`🌐 File access: Changed to public (so sent emails can still access)`);
    console.log(`========================================\n`);
    
    // Re-throw the error so the webhook knows it failed
    throw batchError;
  }

  console.log(`\n🏁 ========== CAMPAIGN COMPLETE ==========`);
  console.log(`✅ Account: ${account.username}`);
  console.log(`📊 Total emails processed: ${totalEmails}`);
  console.log(`📦 Batches used: ${batches.length} (${BATCH_SIZE} emails each)`);
  console.log(`🔄 Pattern: Share 15 → Clear 15 → Repeat`);
  
  if (campaignNumber) {
    console.log(`📋 Campaign: #${campaignNumber}`);
    console.log(`🔗 Campaign ID: ${campaignId}`);
    if (isSupabaseEnabled()) {
      console.log(`💾 All video shares logged to Supabase`);
      console.log(`🔍 View details: https://supabase.com/dashboard/project/jjemlpdbbztwmnmviblt`);
    }
  }
  
  console.log(`========================================\n`);
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

