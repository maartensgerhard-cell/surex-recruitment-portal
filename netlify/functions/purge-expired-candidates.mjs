const json = (statusCode, body) =>
  new Response(JSON.stringify(body), {
    status: statusCode,
    headers: { "Content-Type": "application/json" }
  });

async function getDropboxAccessToken() {
  const appKey = process.env.DROPBOX_APP_KEY;
  const appSecret = process.env.DROPBOX_APP_SECRET;
  const refreshToken = process.env.DROPBOX_REFRESH_TOKEN;

  if (![appKey, appSecret, refreshToken].every(Boolean)) {
    throw new Error("Dropbox server environment variables are missing.");
  }

  const basic = Buffer.from(`${appKey}:${appSecret}`).toString("base64");
  const response = await fetch("https://api.dropbox.com/oauth2/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken
    })
  });

  if (!response.ok) {
    const detail = await response.text();
    console.error("Dropbox token refresh failed:", detail);
    throw new Error("Could not authorise Dropbox.");
  }

  const data = await response.json();
  return data.access_token;
}

async function deleteDropboxFolder(accessToken, path) {
  const response = await fetch("https://api.dropboxapi.com/2/files/delete_v2", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ path })
  });

  const data = await response.json().catch(() => ({}));
  if (response.ok) return;

  // A folder that has already been removed is treated as successfully cleaned up.
  const errorTag = data?.error?.[".tag"];
  const pathTag = data?.error?.path?.[".tag"];
  const summary = String(data?.error_summary || "").toLowerCase();
  if (
    errorTag === "path" &&
    (pathTag === "not_found" || summary.includes("not_found"))
  ) {
    return;
  }

  console.error("Dropbox folder deletion failed:", path, JSON.stringify(data));
  throw new Error("Dropbox could not delete the candidate folder.");
}

async function supabaseRequest(url, serviceKey, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      ...(options.headers || {})
    }
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Supabase HTTP ${response.status}: ${detail.slice(0, 600)}`);
  }

  if (response.status === 204) return null;
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

export const config = {
  // Runs daily at 02:00 UTC (04:00 South African time).
  schedule: "0 2 * * *"
};

export default async () => {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const enabled = process.env.PURGE_EXPIRED_ENABLED === "true";

  if (!supabaseUrl || !serviceKey) {
    console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.");
    return json(500, { error: "Required Supabase server environment variables are missing." });
  }

  const now = new Date().toISOString();
  const candidateUrl = new URL(`${supabaseUrl}/rest/v1/candidates`);
  candidateUrl.searchParams.set("select", "id,full_name,dropbox_folder_path,deleted_at,permanent_delete_at");
  candidateUrl.searchParams.set("deleted_at", "not.is.null");
  candidateUrl.searchParams.set("permanent_delete_at", `lte.${now}`);
  candidateUrl.searchParams.set("order", "permanent_delete_at.asc");
  candidateUrl.searchParams.set("limit", "100");

  try {
    const expired = await supabaseRequest(candidateUrl, serviceKey);
    const candidates = Array.isArray(expired) ? expired : [];

    if (!enabled) {
      console.log(`DRY RUN: ${candidates.length} candidate(s) are eligible for permanent deletion. No records or Dropbox folders were changed.`);
      return json(200, {
        mode: "dry_run",
        checkedAt: now,
        eligibleCount: candidates.length,
        message: "Permanent deletion is disabled. No data was changed."
      });
    }

    if (candidates.length === 0) {
      console.log("No candidates have reached their permanent deletion date.");
      return json(200, { mode: "active", deletedCount: 0, failedCount: 0 });
    }

    const dropboxToken = await getDropboxAccessToken();
    const results = [];

    for (const candidate of candidates) {
      try {
        if (!candidate.dropbox_folder_path) {
          throw new Error("Candidate has no saved Dropbox folder path; skipped to avoid leaving files behind.");
        }

        // Remove the Dropbox folder first. If Dropbox is unavailable, keep the
        // Supabase records so the next scheduled run can safely retry.
        await deleteDropboxFolder(dropboxToken, candidate.dropbox_folder_path);

        const documentsUrl = new URL(`${supabaseUrl}/rest/v1/candidate_documents`);
        documentsUrl.searchParams.set("candidate_id", `eq.${candidate.id}`);
        await supabaseRequest(documentsUrl, serviceKey, { method: "DELETE" });

        const deleteCandidateUrl = new URL(`${supabaseUrl}/rest/v1/candidates`);
        deleteCandidateUrl.searchParams.set("id", `eq.${candidate.id}`);
        deleteCandidateUrl.searchParams.set("deleted_at", "not.is.null");
        deleteCandidateUrl.searchParams.set("permanent_delete_at", `lte.${now}`);

        const deletedRows = await supabaseRequest(deleteCandidateUrl, serviceKey, {
          method: "DELETE",
          headers: { Prefer: "return=representation" }
        });

        if (!Array.isArray(deletedRows) || deletedRows.length !== 1) {
          throw new Error("Candidate record was not deleted; it may have been restored or changed during cleanup.");
        }

        // Preserve the audit trail. candidate_id is deliberately null because
        // the candidate has now been permanently removed.
        const auditUrl = `${supabaseUrl}/rest/v1/activity_logs`;
        await supabaseRequest(auditUrl, serviceKey, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Prefer: "return=minimal"
          },
          body: JSON.stringify({
            candidate_id: null,
            actor_id: null,
            action: "candidate_permanently_deleted",
            details: {
              candidate_id: candidate.id,
              candidate_name: candidate.full_name,
              dropbox_folder_path: candidate.dropbox_folder_path,
              permanent_delete_at: candidate.permanent_delete_at,
              deleted_by: "automatic_system_cleanup"
            }
          })
        });

        results.push({ candidateId: candidate.id, status: "deleted" });
        console.log(`Permanently deleted expired candidate: ${candidate.id}`);
      } catch (error) {
        console.error(`Cleanup failed for candidate ${candidate.id}:`, error);
        results.push({
          candidateId: candidate.id,
          status: "failed",
          error: error.message
        });
      }
    }

    const deletedCount = results.filter(item => item.status === "deleted").length;
    const failedCount = results.length - deletedCount;

    return json(200, {
      mode: "active",
      checkedAt: now,
      deletedCount,
      failedCount,
      results
    });
  } catch (error) {
    console.error("Expired candidate cleanup failed:", error);
    return json(500, { error: error.message || "Cleanup failed." });
  }
};
