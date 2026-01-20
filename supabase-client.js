// ==============================
// SUPABASE CLIENT - Video Outreach Automation
// Helper functions for database operations
// ==============================

import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

dotenv.config();

// ========== CONFIGURATION ==========
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.warn("⚠️ Supabase credentials not found in .env file. Database logging will be disabled.");
}

// Create Supabase client (will be null if credentials are missing)
export const supabase = supabaseUrl && supabaseKey 
  ? createClient(supabaseUrl, supabaseKey)
  : null;

// ========== HELPER FUNCTIONS ==========

/**
 * Check if Supabase is enabled
 */
export function isSupabaseEnabled() {
  return supabase !== null;
}

/**
 * Extract Google Sheet ID and GID from URL
 * @param {string} sheetUrl - Full Google Sheets URL
 * @returns {Object} { sheetId, gid }
 */
export function parseGoogleSheetUrl(sheetUrl) {
  try {
    // Extract spreadsheet ID
    const spreadsheetIdMatch = sheetUrl.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
    if (!spreadsheetIdMatch) {
      throw new Error("Invalid Google Sheets URL - cannot find spreadsheet ID");
    }

    const sheetId = spreadsheetIdMatch[1];

    // Extract GID (defaults to 0 if not found)
    let gid = "0";
    const gidMatch = sheetUrl.match(/[#?&]gid=([0-9]+)/);
    if (gidMatch) {
      gid = gidMatch[1];
    }

    return { sheetId, gid };
  } catch (error) {
    throw new Error(`Failed to parse Google Sheets URL: ${error.message}`);
  }
}

/**
 * Create a new campaign in Supabase
 * @param {Object} data - Campaign data
 * @returns {Promise<Object>} Created campaign
 */
export async function createCampaign(data) {
  if (!isSupabaseEnabled()) {
    console.log("⚠️ Supabase disabled, skipping campaign creation");
    return null;
  }

  try {
    const { data: campaign, error } = await supabase
      .from("campaigns")
      .insert({
        google_sheet_url: data.sheetUrl,
        google_sheet_id: data.sheetId,
        google_sheet_gid: data.sheetGid || "0",
        zight_account: data.zightUsername,
        total_leads: data.totalLeads || 0,
        status: "pending",
        submitted_by: data.submittedBy || null,
        notes: data.notes || null,
      })
      .select()
      .single();

    if (error) throw error;

    console.log(`✅ Campaign created: #${campaign.campaign_number} (ID: ${campaign.id})`);
    return campaign;
  } catch (error) {
    console.error("❌ Error creating campaign:", error.message);
    throw error;
  }
}

/**
 * Update campaign status
 * @param {string} campaignId - Campaign UUID
 * @param {string} status - New status (pending, in_progress, completed, failed)
 * @param {string} errorMessage - Optional error message
 */
export async function updateCampaignStatus(campaignId, status, errorMessage = null) {
  if (!isSupabaseEnabled() || !campaignId) {
    return;
  }

  try {
    const updateData = { status };

    if (status === "completed") {
      updateData.completed_at = new Date().toISOString();
    }

    if (errorMessage) {
      updateData.error_message = errorMessage;
    }

    const { error } = await supabase
      .from("campaigns")
      .update(updateData)
      .eq("id", campaignId);

    if (error) throw error;

    console.log(`✅ Campaign ${campaignId} status updated to: ${status}`);
  } catch (error) {
    console.error("❌ Error updating campaign status:", error.message);
    throw error;
  }
}

/**
 * Update total leads count for a campaign
 * @param {string} campaignId - Campaign UUID
 * @param {number} totalLeads - Total number of leads
 */
export async function updateCampaignLeads(campaignId, totalLeads) {
  if (!isSupabaseEnabled() || !campaignId) {
    return;
  }

  try {
    const { error } = await supabase
      .from("campaigns")
      .update({ total_leads: totalLeads })
      .eq("id", campaignId);

    if (error) throw error;

    console.log(`✅ Campaign ${campaignId} total_leads updated to: ${totalLeads}`);
  } catch (error) {
    console.error("❌ Error updating campaign leads:", error.message);
    throw error;
  }
}

/**
 * Log a video share to Supabase
 * @param {Object} data - Video share data
 */
export async function logVideoShare(data) {
  if (!isSupabaseEnabled() || !data.campaignId) {
    return;
  }

  try {
    const { error } = await supabase
      .from("video_shares")
      .insert({
        campaign_id: data.campaignId,
        email: data.email,
        zight_account: data.zightAccount,
        google_sheet_link: data.googleSheetLink,
        status: data.status || "sent",
        error_message: data.errorMessage || null,
      });

    if (error) throw error;

    // Don't log success for each video (too verbose), only errors
    if (data.status === "failed") {
      console.log(`❌ Video share failed logged: ${data.email}`);
    }
  } catch (error) {
    console.error(`⚠️ Error logging video share for ${data.email}:`, error.message);
    // Don't throw - we don't want to stop automation if logging fails
  }
}

/**
 * Log multiple video shares at once (batch insert)
 * @param {Array} shares - Array of video share objects
 */
export async function logVideoSharesBatch(shares) {
  if (!isSupabaseEnabled() || !shares || shares.length === 0) {
    return;
  }

  try {
    const records = shares.map(share => ({
      campaign_id: share.campaignId,
      email: share.email,
      zight_account: share.zightAccount,
      google_sheet_link: share.googleSheetLink,
      status: share.status || "sent",
      error_message: share.errorMessage || null,
    }));

    const { error } = await supabase
      .from("video_shares")
      .insert(records);

    if (error) throw error;

    console.log(`💾 Logged ${shares.length} video share(s) to Supabase`);
  } catch (error) {
    console.error(`⚠️ Error logging batch video shares:`, error.message);
    // Don't throw - we don't want to stop automation if logging fails
  }
}

/**
 * Get campaign statistics
 * @param {number} campaignNumber - Campaign number (not UUID)
 * @returns {Promise<Object>} Campaign statistics
 */
export async function getCampaignStats(campaignNumber) {
  if (!isSupabaseEnabled()) {
    return null;
  }

  try {
    const { data, error } = await supabase
      .from("campaign_stats")
      .select("*")
      .eq("campaign_number", campaignNumber)
      .single();

    if (error) throw error;

    return data;
  } catch (error) {
    console.error("❌ Error getting campaign stats:", error.message);
    throw error;
  }
}

/**
 * Get all campaigns with optional filters
 * @param {Object} filters - Optional filters
 * @returns {Promise<Array>} Array of campaigns
 */
export async function getCampaigns(filters = {}) {
  if (!isSupabaseEnabled()) {
    return [];
  }

  try {
    let query = supabase
      .from("campaigns")
      .select("*")
      .order("created_at", { ascending: false });

    // Apply filters
    if (filters.status) {
      query = query.eq("status", filters.status);
    }

    if (filters.zightAccount) {
      query = query.eq("zight_account", filters.zightAccount);
    }

    if (filters.limit) {
      query = query.limit(filters.limit);
    }

    const { data, error } = await query;

    if (error) throw error;

    return data;
  } catch (error) {
    console.error("❌ Error getting campaigns:", error.message);
    throw error;
  }
}

/**
 * Get video shares for a specific campaign
 * @param {string} campaignId - Campaign UUID
 * @returns {Promise<Array>} Array of video shares
 */
export async function getVideoShares(campaignId) {
  if (!isSupabaseEnabled()) {
    return [];
  }

  try {
    const { data, error } = await supabase
      .from("video_shares")
      .select("*")
      .eq("campaign_id", campaignId)
      .order("shared_at", { ascending: false });

    if (error) throw error;

    return data;
  } catch (error) {
    console.error("❌ Error getting video shares:", error.message);
    throw error;
  }
}

// Export all functions
export default {
  supabase,
  isSupabaseEnabled,
  parseGoogleSheetUrl,
  createCampaign,
  updateCampaignStatus,
  updateCampaignLeads,
  logVideoShare,
  logVideoSharesBatch,
  getCampaignStats,
  getCampaigns,
  getVideoShares,
};
