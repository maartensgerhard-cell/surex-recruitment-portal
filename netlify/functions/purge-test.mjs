import crypto from "node:crypto";

const json = (statusCode, body) =>
  new Response(JSON.stringify(body), {
    status: statusCode,
    headers: { "Content-Type": "application/json" }
  });

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
    throw new Error(`Supabase HTTP ${response.status}: ${detail.slice(0, 500)}`);
  }
  if (response.status === 204) return null;
  const body = await response.text();
  return body ? JSON.parse(body) : null;
}

async function rpc(base, key, name, id) {
  return supabaseRequest(`${base}/rest/v1/rpc/${name}`, key, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ p_candidate_id: id })
  });
}

async function getDropboxToken() {
  const { DROPBOX_APP_KEY, DROPBOX_APP_SECRET, DROPBOX_REFRESH_TOKEN } = process.env;
  if (![DROPBOX_APP_KEY, DROPBOX_APP_SECRET, DROPBOX_REFRESH_TOKEN].every(Boolean)) {
    throw new Error("Dropbox server settings are incomplete.");
  }
  const basic = Buffer.from(`${DROPBOX_APP_KEY}:${DROPBOX_APP_SECRET}`).toString("base64");
  const response = await fetch("https://api.dropbox.com/oauth2/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: DROPBOX_REFRESH_TOKEN
    })
  });
  if (!response.ok) throw new Error("Dropbox authorisation failed.");
  return (await response.json()).access_token;
}

async function deleteDropboxFolder(token, path) {
  const response = await fetch("https://api.dropboxapi.com/2/files/delete_v2", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ path })
  });
  const data = await response.json().catch(() => ({}));
  if (response.ok) return;
  const tag = data?.error?.path?.[".tag"];
  const summary = String(data?.error_summary || "").toLowerCase();
  if (data?.error?.[".tag"] === "path" &&
      (tag === "not_found" || summary.includes("not_found"))) return;
  throw new Error("Dropbox could not delete the test candidate folder.");
}

export default async (request) => {
  if (request.method !== "POST") {
    return json(405, { error: "Use POST for this restricted test." });
  }

  const expectedToken = process.env.PURGE_TEST_TOKEN;
  const suppliedToken = request.headers.get("x-purge-test-token") || "";
  if (!expectedToken || suppliedToken.length !== expectedToken.length ||
      !crypto.timingSafeEqual(Buffer.from(suppliedToken), Buffer.from(expectedToken))) {
    return json(401, { error: "Not authorised." });
  }

  const base = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !key) return json(500, { error: "Supabase server settings are incomplete." });

  let claimed = false;
  let candidateId = null;

  try {
    const lookup = new URL(`${base}/rest/v1/candidates`);
    lookup.searchParams.set("select", "id,full_name,dropbox_folder_path,deleted_at,permanent_delete_at");
    lookup.searchParams.set("full_name", "eq.purge test");
    lookup.searchParams.set("deleted_at", "not.is.null");
    lookup.searchParams.set("permanent_delete_at", `lte.${new Date().toISOString()}`);
    const matches = await supabaseRequest(lookup, key);

    if (!Array.isArray(matches) || matches.length !== 1) {
      return json(409, {
        error: "Safety check stopped: expected exactly one expired, deleted candidate named 'purge test'.",
        matchedCount: Array.isArray(matches) ? matches.length : 0
      });
    }

    const candidate = matches[0];
    candidateId = candidate.id;
    if (!candidate.dropbox_folder_path ||
        !candidate.dropbox_folder_path.endsWith("/purge test")) {
      return json(409, { error: "Safety check stopped: unexpected Dropbox folder path." });
    }

    const claim = await rpc(base, key, "claim_expired_candidate", candidate.id);
    if (!claim) return json(409, { error: "Candidate could not be claimed; no deletion was attempted." });
    claimed = true;

    const token = await getDropboxToken();
    await deleteDropboxFolder(token, candidate.dropbox_folder_path);

    const finalised = await rpc(base, key, "finalize_expired_candidate", candidate.id);
    if (finalised !== true) {
      throw new Error("Database did not confirm final deletion. The candidate record was retained.");
    }
    claimed = false;

    return json(200, {
      mode: "single_candidate_test",
      status: "deleted",
      candidateName: "purge test",
      message: "The test candidate, its documents, and its Dropbox folder were permanently deleted. The audit log was preserved."
    });
  } catch (error) {
    if (claimed && candidateId) {
      try {
        await rpc(base, key, "release_expired_candidate", candidateId);
      } catch (releaseError) {
        console.error("Could not release test candidate lock:", releaseError);
      }
    }
    console.error("Restricted purge test failed:", error);
    return json(500, { error: error.message || "Restricted purge test failed." });
  }
};