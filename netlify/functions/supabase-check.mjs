
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

  const url = process.env.SUPABASE_URL?.trim().replace(/\/+$/, "");
  const key = process.env.SUPABASE_ANON_KEY?.trim();

  if (!url || !key) {
    return new Response(
      JSON.stringify({
        ok: false,
        message: "Required environment variables are missing.",
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  try {
    const response = await fetch(`${url}/auth/v1/health`, {
      headers: {
        apikey: key,
      },
    });

    return new Response(
      JSON.stringify({
        ok: response.ok,
        status: response.status,
        message: response.ok
          ? "Supabase Auth API is reachable."
          : "Supabase Auth API did not accept the request.",
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
        message: "Could not reach Supabase.",
      }),
      {
        status: 502,
        headers: { "Content-Type": "application/json" },
      }
    );
  }
};
