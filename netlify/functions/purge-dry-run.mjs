export default async (request) => {
  const headers = { "Content-Type": "application/json" };

  if (request.method !== "GET") {
    return new Response(JSON.stringify({ error: "Use GET for this safe test." }), {
      status: 405,
      headers
    });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceKey) {
    return new Response(JSON.stringify({
      error: "Required Supabase server environment variables are missing."
    }), { status: 500, headers });
  }

  try {
    const now = new Date().toISOString();
    const url = new URL(`${supabaseUrl}/rest/v1/candidates`);
    url.searchParams.set("select", "id");
    url.searchParams.set("deleted_at", "not.is.null");
    url.searchParams.set("permanent_delete_at", `lte.${now}`);
    url.searchParams.set("limit", "100");

    const response = await fetch(url, {
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`
      }
    });

    if (!response.ok) {
      const detail = await response.text();
      console.error("Supabase dry-run check failed:", detail);
      return new Response(JSON.stringify({
        error: `Supabase returned HTTP ${response.status}. Check the Netlify function logs.`
      }), { status: 502, headers });
    }

    const rows = await response.json();
    const eligibleCount = Array.isArray(rows) ? rows.length : 0;

    console.log(`MANUAL DRY RUN: ${eligibleCount} candidate(s) eligible. No data was changed.`);

    return new Response(JSON.stringify({
      mode: "dry_run",
      checkedAt: now,
      eligibleCount,
      message: "Safe test completed. No candidates, documents, or Dropbox folders were changed."
    }), { status: 200, headers });
  } catch (error) {
    console.error("Manual dry-run test failed:", error);
    return new Response(JSON.stringify({
      error: "The safe test failed. Check the Netlify function logs."
    }), { status: 500, headers });
  }
};
