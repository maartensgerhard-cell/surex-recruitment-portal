
export default async (request) => {
  if (request.method !== "GET") {
    return new Response(
      JSON.stringify({ error: "Method not allowed" }),
      {
        status: 405,
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  const supabaseUrl = process.env.SUPABASE_URL?.trim();
  const supabaseKey = process.env.SUPABASE_ANON_KEY?.trim();

  if (!supabaseUrl || !supabaseKey) {
    return new Response(
      JSON.stringify({
        ok: false,
        status: 500,
        errorCode: "MISSING_ENVIRONMENT_VARIABLE",
        message: "A required Supabase environment variable is missing.",
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  try {
    const response = await fetch(
      `${supabaseUrl.replace(/\/+$/, "")}/rest/v1/branches?select=id&limit=1`,
      {
        headers: {
          apikey: supabaseKey,
          Authorization: `Bearer ${supabaseKey}`,
        },
      }
    );

    const errorCode = response.ok
      ? null
      : response.status === 401
        ? "UNAUTHORIZED"
        : response.status === 403
          ? "FORBIDDEN"
          : response.status === 404
            ? "ENDPOINT_NOT_FOUND"
            : "SUPABASE_REQUEST_FAILED";

    return new Response(
      JSON.stringify({
        ok: response.ok,
        status: response.status,
        errorCode,
        message: response.ok
          ? "Supabase connection successful."
          : "Supabase rejected the request. Check the key type, project URL, and API configuration.",
      }),
      {
        status: response.ok ? 200 : 502,
        headers: { "Content-Type": "application/json" },
      }
    );
  } catch {
    return new Response(
      JSON.stringify({
        ok: false,
        status: 502,
        errorCode: "CONNECTION_FAILED",
        message: "Could not reach Supabase. Check the project URL and network connection.",
      }),
      {
        status: 502,
        headers: { "Content-Type": "application/json" },
      }
    );
  }
};
