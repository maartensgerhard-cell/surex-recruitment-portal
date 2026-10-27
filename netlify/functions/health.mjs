
export default async function handler() {
  return new Response(
    JSON.stringify({
      status: "ok",
      application: "SureX Recruitment Portal",
      message: "Backend function is running"
    }),
    {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store"
      }
    }
  );
}
