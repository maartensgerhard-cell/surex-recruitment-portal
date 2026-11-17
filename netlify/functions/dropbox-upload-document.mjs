
export default async (req) => {
  const headers = { "Content-Type": "application/json" };

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...headers, Allow: "POST" }
    });
  }

  try {
    const authHeader = req.headers.get("authorization") || "";
    const accessToken = authHeader.replace(/^Bearer\s+/i, "").trim();

    if (!accessToken) {
      return new Response(JSON.stringify({ error: "Sign-in required." }), {
        status: 401,
        headers
      });
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

    // Verify signed-in user
    const userResponse = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: commonHeaders
    });

    if (!userResponse.ok) {
      return new Response(JSON.stringify({
        error: "Your session is invalid. Please sign in again."
      }), { status: 401, headers });
    }

    const user = await userResponse.json();

    // Verify portal role
    const roleResponse = await fetch(`${supabaseUrl}/rest/v1/rpc/get_my_role`, {
      method: "POST",
      headers: {
        ...commonHeaders,
        "Content-Type": "application/json"
      },
      body: "{}"
    });

    if (!roleResponse.ok) {
      return new Response(JSON.stringify({
        error: "Could not verify portal permissions."
      }), { status: 403, headers });
    }

    const role = await roleResponse.json();

    if (!["admin", "assistant"].includes(role)) {
      return new Response(JSON.stringify({
        error: "You do not have permission to upload documents."
      }), { status: 403, headers });
    }

    // Read uploaded form
    const form = await req.formData();
    const candidateId = String(form.get("candidateId") || "").trim();
    const documentType = String(form.get("documentType") || "").trim();
    const file = form.get("file");

    const allowedTypes = [
      "MIE Screening",
      "ID",
      "Matric",
      "Driver's Licence",
      "Tax",
      "Bank Confirmation",
      "CV"
    ];

    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(candidateId)) {
      return new Response(JSON.stringify({
        error: "Invalid candidate reference."
      }), { status: 400, headers });
    }

    if (!allowedTypes.includes(documentType)) {
      return new Response(JSON.stringify({
        error: "Select a valid document type."
      }), { status: 400, headers });
    }

    if (!file || typeof file.arrayBuffer !== "function" || !file.name) {
      return new Response(JSON.stringify({
        error: "Choose a file to upload."
      }), { status: 400, headers });
    }

    if (file.size <= 0 || file.size > 20 * 1024 * 1024) {
      return new Response(JSON.stringify({
        error: "The file must be larger than 0 bytes and no bigger than 20 MB."
      }), { status: 400, headers });
    }

    // Find candidate
    const candidateUrl = new URL(`${supabaseUrl}/rest/v1/candidates`);
    candidateUrl.searchParams.set("id", `eq.${candidateId}`);
    candidateUrl.searchParams.set("deleted_at", "is.null");
    candidateUrl.searchParams.set("select", "id,full_name,dropbox_folder_path,mie_check");

    const candidateResponse = await fetch(candidateUrl, {
      headers: commonHeaders
    });

    if (!candidateResponse.ok) {
      throw new Error("Could not verify the candidate record.");
    }

    const candidateRows = await candidateResponse.json();
    const candidate = candidateRows[0];

    if (!candidate) {
      return new Response(JSON.stringify({
        error: "Candidate not found or access denied."
      }), { status: 404, headers });
    }

    if (!candidate.dropbox_folder_path) {
      return new Response(JSON.stringify({
        error: "This candidate does not have a Dropbox folder yet. Save the candidate again or contact the administrator."
      }), { status: 409, headers });
    }

    // Enforce MIE-first process
    const mieResult = String(candidate.mie_check || "").trim().toLowerCase();
    const mieCleared = ["cleared", "clear", "passed"].includes(mieResult);

    if (documentType !== "MIE Screening" && !mieCleared) {
      return new Response(JSON.stringify({
        error: "Upload the MIE screening document and record a cleared MIE result before uploading the other candidate documents."
      }), { status: 409, headers });
    }

    // Prepare Dropbox filename and path
    const originalName = String(file.name)
      .split(/[\\/]/)
      .pop()
      .replace(/[<>:"|?*\\x00-\\x1F]/g, "_")
      .trim()
      .slice(0, 180) || "document";

    const safeType = documentType
      .replace(/[^a-zA-Z0-9 -]/g, "")
      .replace(/\s+/g, "_");

    const dropboxPath = `${candidate.dropbox_folder_path}/${safeType} - ${originalName}`;

    // Refresh Dropbox access token
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
      throw new Error("Dropbox authorisation failed. Check the Dropbox environment variables.");
    }

    const tokenData = await tokenResponse.json();

    // Upload file to Dropbox
    const fileBytes = await file.arrayBuffer();

    const uploadResponse = await fetch("https://content.dropboxapi.com/2/files/upload", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`,
        "Content-Type": "application/octet-stream",
        "Dropbox-API-Arg": JSON.stringify({
          path: dropboxPath,
          mode: "add",
          autorename: true,
          mute: false,
          strict_conflict: false
        })
      },
      body: fileBytes
    });

    const uploadData = await uploadResponse.json();

    if (!uploadResponse.ok) {
      console.error("Dropbox document upload failed:", JSON.stringify(uploadData));
      throw new Error("Dropbox could not upload this document. Please try again.");
    }

    const savedPath = uploadData.path_display || dropboxPath;

    // Save document record in Supabase and request the inserted row back
    const documentResponse = await fetch(`${supabaseUrl}/rest/v1/candidate_documents`, {
      method: "POST",
      headers: {
        ...commonHeaders,
        "Content-Type": "application/json",
        Prefer: "return=representation"
      },
      body: JSON.stringify({
        candidate_id: candidateId,
        document_type: documentType,
        dropbox_path: savedPath,
        original_filename: file.name,
        uploaded_by: user.id
      })
    });

    if (!documentResponse.ok) {
      const databaseError = await documentResponse.text();

      console.error(
        "Document record save failed:",
        documentResponse.status,
        databaseError
      );

      throw new Error(
        "Database HTTP " +
        documentResponse.status +
        ": " +
        databaseError.slice(0, 700)
      );
    }

    const savedRecords = await documentResponse.json();

    if (!Array.isArray(savedRecords) || savedRecords.length !== 1) {
      throw new Error(
        "Supabase did not confirm that exactly one document record was saved."
      );
    }

    // Confirm successful upload and database save
    return new Response(JSON.stringify({
      success: true,
      documentType,
      fileName: file.name,
      dropboxPath: savedPath,
      databaseRecord: savedRecords[0],
      message: "Document uploaded and saved successfully."
    }), {
      status: 200,
      headers
    });

  } catch (error) {
    console.error("Dropbox document upload:", error);

    return new Response(JSON.stringify({
      error: error.message || "Document upload failed."
    }), {
      status: 500,
      headers
    });
  }
};

