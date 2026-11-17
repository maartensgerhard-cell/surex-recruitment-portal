export default async (req) => {
  const jsonHeaders = { "Content-Type": "application/json" };

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...jsonHeaders, Allow: "POST" }
    });
  }

  try {
    const authHeader = req.headers.get("authorization") || "";
    const accessToken = authHeader.replace(/^Bearer\s+/i, "").trim();
    if (!accessToken) {
      return new Response(JSON.stringify({ error: "Sign-in required." }), { status: 401, headers: jsonHeaders });
    }

    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_ANON_KEY;
    const appKey = process.env.DROPBOX_APP_KEY;
    const appSecret = process.env.DROPBOX_APP_SECRET;
    const refreshToken = process.env.DROPBOX_REFRESH_TOKEN;

    if (![supabaseUrl, supabaseKey, appKey, appSecret, refreshToken].every(Boolean)) {
      throw new Error("A required server environment variable is missing.");
    }

    const commonHeaders = {
      apikey: supabaseKey,
      Authorization: `Bearer ${accessToken}`
    };

    const userResponse = await fetch(`${supabaseUrl}/auth/v1/user`, { headers: commonHeaders });
    if (!userResponse.ok) {
      return new Response(JSON.stringify({ error: "Your session is invalid. Please sign in again." }), { status: 401, headers: jsonHeaders });
    }

    const user = await userResponse.json();
    const roleResponse = await fetch(`${supabaseUrl}/rest/v1/rpc/get_my_role`, {
      method: "POST",
      headers: { ...commonHeaders, "Content-Type": "application/json" },
      body: "{}"
    });
    if (!roleResponse.ok) {
      return new Response(JSON.stringify({ error: "Could not verify portal permissions." }), { status: 403, headers: jsonHeaders });
    }

    const role = await roleResponse.json();
    if (!["admin", "assistant"].includes(role)) {
      return new Response(JSON.stringify({ error: "You do not have permission to download candidate packs." }), { status: 403, headers: jsonHeaders });
    }

    const body = await req.json();
    const candidateId = String(body?.candidateId || "").trim();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(candidateId)) {
      return new Response(JSON.stringify({ error: "Invalid candidate reference." }), { status: 400, headers: jsonHeaders });
    }

    const candidateUrl = new URL(`${supabaseUrl}/rest/v1/candidates`);
    candidateUrl.searchParams.set("id", `eq.${candidateId}`);
    candidateUrl.searchParams.set("deleted_at", "is.null");
    candidateUrl.searchParams.set("select", "id,full_name,status,dropbox_folder_path");
    const candidateResponse = await fetch(candidateUrl, { headers: commonHeaders });
    if (!candidateResponse.ok) throw new Error("Could not verify the candidate record.");
    const candidateRows = await candidateResponse.json();
    const candidate = candidateRows[0];

    if (!candidate) {
      return new Response(JSON.stringify({ error: "Candidate not found or access denied." }), { status: 404, headers: jsonHeaders });
    }
    if (candidate.status !== "Ready for Submission") {
      return new Response(JSON.stringify({ error: "The candidate must be Ready for Submission before the pack can be downloaded." }), { status: 409, headers: jsonHeaders });
    }
    if (!candidate.dropbox_folder_path) {
      return new Response(JSON.stringify({ error: "No Dropbox folder is recorded for this candidate." }), { status: 409, headers: jsonHeaders });
    }

    const docsUrl = new URL(`${supabaseUrl}/rest/v1/candidate_documents`);
    docsUrl.searchParams.set("candidate_id", `eq.${candidateId}`);
    docsUrl.searchParams.set("select", "document_type,dropbox_path");
    const docsResponse = await fetch(docsUrl, { headers: commonHeaders });
    if (!docsResponse.ok) throw new Error("Could not verify the candidate document checklist.");
    const docs = await docsResponse.json();

    const required = [
      "MIE Screening",
      "ID",
      "Matric",
      "Driver's Licence",
      "Tax",
      "Bank Confirmation",
      "CV"
    ];
    const uploaded = new Set(docs.filter(doc => doc.dropbox_path).map(doc => doc.document_type));
    const missing = required.filter(type => !uploaded.has(type));
    if (missing.length) {
      return new Response(JSON.stringify({
        error: "The candidate pack is incomplete. Missing: " + missing.join(", ")
      }), { status: 409, headers: jsonHeaders });
    }

    const basic = Buffer.from(`${appKey}:${appSecret}`).toString("base64");
    const tokenResponse = await fetch("https://api.dropbox.com/oauth2/token", {
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
    if (!tokenResponse.ok) {
      console.error("Dropbox token refresh failed:", await tokenResponse.text());
      throw new Error("Dropbox authorisation failed. Please contact the portal administrator.");
    }
    const tokenData = await tokenResponse.json();

    // Dropbox creates a ZIP of the candidate's folder. The response is streamed back
    // to the signed-in portal user; no public Dropbox link is created.
    const zipResponse = await fetch("https://content.dropboxapi.com/2/files/download_zip", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`,
        "Dropbox-API-Arg": JSON.stringify({ path: candidate.dropbox_folder_path })
      }
    });

    if (!zipResponse.ok) {
      const detail = await zipResponse.text();
      console.error("Dropbox ZIP download failed:", zipResponse.status, detail);
      throw new Error("Dropbox could not prepare the candidate ZIP. Please try again or contact the administrator.");
    }

    const safeName = String(candidate.full_name || "Candidate")
      .replace(/[^a-z0-9 _-]/gi, "")
      .trim()
      .slice(0, 100) || "Candidate";

    return new Response(zipResponse.body, {
      status: 200,
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${safeName} - Candidate Pack.zip"`,
        "Cache-Control": "no-store"
      }
    });
  } catch (error) {
    console.error("Candidate pack download:", error);
    return new Response(JSON.stringify({
      error: error.message || "Candidate pack download failed."
    }), { status: 500, headers: jsonHeaders });
  }
};
