export default async (req) => {
  const headers = { "Content-Type": "application/json" };

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405, headers: { ...headers, Allow: "POST" }
    });
  }

  try {
    const authHeader = req.headers.get("authorization") || "";
    const accessToken = authHeader.replace(/^Bearer\s+/i, "");
    if (!accessToken) {
      return new Response(JSON.stringify({ error: "Sign-in required." }), { status: 401, headers });
    }

    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_ANON_KEY;
    const appKey = process.env.DROPBOX_APP_KEY;
    const appSecret = process.env.DROPBOX_APP_SECRET;
    const refreshToken = process.env.DROPBOX_REFRESH_TOKEN;

    if (![supabaseUrl, supabaseKey, appKey, appSecret, refreshToken].every(Boolean)) {
      throw new Error("A required server environment variable is missing.");
    }

    const userResponse = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: { apikey: supabaseKey, Authorization: `Bearer ${accessToken}` }
    });
    if (!userResponse.ok) {
      return new Response(JSON.stringify({ error: "Your session is invalid. Please sign in again." }), { status: 401, headers });
    }

    const roleResponse = await fetch(`${supabaseUrl}/rest/v1/rpc/get_my_role`, {
      method: "POST",
      headers: {
        apikey: supabaseKey,
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      },
      body: "{}"
    });
    if (!roleResponse.ok) {
      return new Response(JSON.stringify({ error: "Could not verify portal permissions." }), { status: 403, headers });
    }
    const role = await roleResponse.json();
    if (!["admin", "assistant"].includes(role)) {
      return new Response(JSON.stringify({ error: "You do not have permission to create candidate folders." }), { status: 403, headers });
    }

    const body = await req.json();
    const candidateName = String(body?.candidateName || "").trim();
    if (!candidateName || candidateName.length > 150 || /[\\/\\0]/.test(candidateName) || candidateName === "." || candidateName === "..") {
      return new Response(JSON.stringify({ error: "Enter a valid candidate name (maximum 150 characters)." }), { status: 400, headers });
    }

    const safeName = candidateName.replace(/[<>:"|?*]/g, "-").replace(/\s+/g, " ").trim();
    const folderPath = `/SureX Free state/SureX Management/Onboarding/Candidate folders/${safeName}`;

    const basic = Buffer.from(`${appKey}:${appSecret}`).toString("base64");
    const tokenResponse = await fetch("https://api.dropbox.com/oauth2/token", {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken })
    });
    if (!tokenResponse.ok) {
      console.error("Dropbox token refresh failed:", await tokenResponse.text());
      throw new Error("Dropbox authorisation failed. Check the Dropbox environment variables.");
    }
    const tokenData = await tokenResponse.json();

    const createResponse = await fetch("https://api.dropboxapi.com/2/files/create_folder_v2", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ path: folderPath, autorename: false })
    });

    const createData = await createResponse.json();
    if (!createResponse.ok) {
      const tag = createData?.error?.[".tag"];
      const summary = createData?.error_summary || "";
      if (tag === "path" && summary.includes("conflict")) {
        return new Response(JSON.stringify({
          created: false,
          exists: true,
          folderPath,
          message: "A folder with this candidate name already exists."
        }), { status: 200, headers });
      }
      console.error("Dropbox folder creation failed:", JSON.stringify(createData));
      throw new Error("Dropbox could not create the candidate folder. Check that the parent folder path exists and that Dropbox folder permissions are enabled.");
    }

    return new Response(JSON.stringify({
      created: true,
      exists: false,
      folderPath: createData?.metadata?.path_display || folderPath,
      message: "Candidate folder created successfully."
    }), { status: 200, headers });
  } catch (error) {
    console.error("Dropbox folder creation:", error);
    return new Response(JSON.stringify({ error: error.message || "Folder creation failed." }), { status: 500, headers });
  }
};
