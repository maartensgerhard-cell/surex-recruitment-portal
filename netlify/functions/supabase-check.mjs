
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

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseKey) {
    return new Response(
      JSON.stringify({
        ok: false,
        message: "Supabase environment variables are missing.",
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  try {
    const response = await fetch(
      `${supabaseUrl}/rest/v1/branches?select=id&limit=1`,
      {
        headers: {
          apikey: supabaseKey,
          Authorization: `Bearer ${supabaseKey}`,
        },
      }
    );

    return new Response(
      JSON.stringify({
        ok: response.ok,
        status: response.status,
        message: response.ok
          ? "Supabase connection successful."
          : "Supabase responded with an error. Check the project URL, key, and database permissions.",
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
        message: "Could not reach Supabase.",
      }),
      {
        status: 502,
        headers: { "Content-Type": "application/json" },
      }
    );
  }
};
