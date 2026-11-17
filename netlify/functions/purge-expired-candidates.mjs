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

  // A folder already removed during an earlier attempt is safe to retry.
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
  const responseText = await response.text();
  return responseText ? JSON.parse(responseText) : null;
}

async function callDatabaseFunction(supabaseUrl, serviceKey, functionName, candidateId) {
  return supabaseRequest(
    `${supabaseUrl}/rest/v1/rpc/${functionName}`,
    serviceKey,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ p_candidate_id: candidateId })
    }
  );
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
    return json(500, {
      error: "Required Supabase server environment variables are missing."
    });
  }

  const now = new Date().toISOString();
  const candidateUrl = new URL(`${supabaseUrl}/rest/v1/candidates`);
  candidateUrl.searchParams.set(
    "select",
    "id,full_name,dropbox_folder_path,deleted_at,permanent_delete_at"
  );
  candidateUrl.searchParams.set("deleted_at", "not.is.null");
  candidateUrl.searchParams.set("permanent_delete_at", `lte.${now}`);
  candidateUrl.searchParams.set("order", "permanent_delete_at.asc");
  candidateUrl.searchParams.set("limit", "100");

  try {
    const expired = await supabaseRequest(candidateUrl, serviceKey);
    const candidates = Array.isArray(expired) ? expired : [];

    if (!enabled) {
      console.log(
        `DRY RUN: ${candidates.length} candidate(s) are eligible for permanent deletion. No records or Dropbox folders were changed.`
      );
      return json(200, {
        mode: "dry_run",
        checkedAt: now,
        eligibleCount: candidates.length,
        message: "Permanent deletion is disabled. No data was changed."
      });
    }

    if (candidates.length === 0) {
      console.log("No candidates have reached their permanent deletion date.");
      return json(200, {
        mode: "active",
        deletedCount: 0,
        failedCount: 0
      });
    }

    const dropboxToken = await getDropboxAccessToken();
    const results = [];

    for (const candidate of candidates) {
      let claimed = false;

      try {
        // Atomically claim the candidate. This prevents a simultaneous restore
        // or a second scheduled invocation from processing the same record.
        const claim = await callDatabaseFunction(
          supabaseUrl,
          serviceKey,
          "claim_expired_candidate",
          candidate.id
        );

        if (!claim) {
          results.push({
            candidateId: candidate.id,
            status: "skipped",
            reason: "Candidate was no longer eligible or is already being processed."
          });
          continue;
        }

        claimed = true;

        if (!candidate.dropbox_folder_path) {
          throw new Error(
            "Candidate has no saved Dropbox folder path; skipped to avoid leaving files behind."
          );
        }

        // Dropbox is removed first. If this or the database transaction fails,
        // the database record remains and the next run can retry safely.
        await deleteDropboxFolder(dropboxToken, candidate.dropbox_folder_path);

        const finalized = await callDatabaseFunction(
          supabaseUrl,
          serviceKey,
          "finalize_expired_candidate",
          candidate.id
        );

        if (finalized !== true) {
          throw new Error(
            "Database finalisation did not confirm deletion. The candidate record was retained."
          );
        }

        claimed = false;
        results.push({ candidateId: candidate.id, status: "deleted" });
        console.log(`Permanently deleted expired candidate: ${candidate.id}`);
      } catch (error) {
        console.error(`Cleanup failed for candidate ${candidate.id}:`, error);

        // Release the lock so a later scheduled run can retry. If Dropbox was
        // already deleted, its not-found response is treated as success above.
        if (claimed) {
          try {
            await callDatabaseFunction(
              supabaseUrl,
              serviceKey,
              "release_expired_candidate",
              candidate.id
            );
          } catch (releaseError) {
            console.error(
              `Could not release cleanup lock for candidate ${candidate.id}:`,
              releaseError
            );
          }
        }

        results.push({
          candidateId: candidate.id,
          status: "failed",
          error: error.message
        });
      }
    }

    const deletedCount = results.filter(item => item.status === "deleted").length;
    const failedCount = results.filter(item => item.status === "failed").length;

    return json(200, {
      mode: "active",
      checkedAt: now,
      deletedCount,
      failedCount,
      results
    });
  } catch (error) {
    console.error("Expired candidate cleanup failed:", error);
    return json(500, {
      error: error.message || "Cleanup failed."
    });
  }
};
