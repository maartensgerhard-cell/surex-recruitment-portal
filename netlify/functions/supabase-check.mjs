
export default async (request) => {
  if (request.method !== "GET") {
    return new Response("Method not allowed", { status: 405 });
  }

  const url = process.env.SUPABASE_URL?.trim().replace(/\/+$/, "");
  const key = process.env.SUPABASE_ANON_KEY?.trim();

  const headers = { "Content-Type": "application/json" };

  if (!url || !key) {
    return new Response(
      JSON.stringify({
        ok: false,
        errorCode: "MISSING_ENVIRONMENT_VARIABLE",
      }),
      { status: 500, headers }
    );
  }

  try {
    const response = await fetch(`${url}/rest/v1/branches?select=id&limit=1`, {
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
      },
    });

    const body = await response.text();
    let category = "OTHER";

    if (response.status === 401) {
      category = "CHECK_API_KEY_AND_PROJECT_URL";
    } else if (response.status === 403) {
      category = "CHECK_DATABASE_PERMISSIONS";
    } else if (response.status === 404) {
      category = "CHECK_REST_ENDPOINT";
    }

    let details = null;
    try {
      const parsed = JSON.parse(body);
      details = {
        code: parsed.code || null,
        message: parsed.message || null,
      };
    } catch {
      details = { message: "Supabase returned a non-JSON response." };
    }

    return new Response(
      JSON.stringify({
        ok: response.ok,
        status: response.status,
        category,
        details,
      }),
      {
        status: response.ok ? 200 : 502,
        headers,
      }
    );
  } catch {
    return new Response(
      JSON.stringify({
        ok: false,
        status: 502,
        category: "CONNECTION_FAILED",
      }),
      { status: 502, headers }
    );
  }
};
