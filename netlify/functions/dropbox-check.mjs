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
    const accessToken = authHeader.replace(/^Bearer\s+/i, "");

    if (!accessToken) {
      return new Response(JSON.stringify({ error: "Sign-in required." }), {
        status: 401, headers
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

    const userResponse = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: {
        apikey: supabaseKey,
        Authorization: `Bearer ${accessToken}`
      }
    });

    if (!userResponse.ok) {
      return new Response(JSON.stringify({ error: "Your session is invalid. Please sign in again." }), {
        status: 401, headers
      });
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
      return new Response(JSON.stringify({ error: "Could not verify portal permissions." }), {
        status: 403, headers
      });
    }

    const role = await roleResponse.json();
    if (!["admin", "assistant"].includes(role)) {
      return new Response(JSON.stringify({ error: "You do not have permission to use Dropbox integration." }), {
        status: 403, headers
      });
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
      const detail = await tokenResponse.text();
      console.error("Dropbox token refresh failed:", detail);
      throw new Error("Dropbox authorisation failed. Check the Dropbox environment variables.");
    }

    const tokenData = await tokenResponse.json();
    const accountResponse = await fetch("https://api.dropboxapi.com/2/users/get_current_account", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`,
        "Content-Type": "application/json"
      },
      body: "null"
    });

    if (!accountResponse.ok) {
      const detail = await accountResponse.text();
      console.error("Dropbox account check failed:", detail);
      throw new Error("Dropbox responded, but the account connection could not be verified.");
    }

    return new Response(JSON.stringify({
      connected: true,
      message: "Dropbox connection verified successfully."
    }), { status: 200, headers });
  } catch (error) {
    console.error("Dropbox connection check:", error);
    return new Response(JSON.stringify({
      error: error.message || "Dropbox connection check failed."
    }), { status: 500, headers });
  }
};
