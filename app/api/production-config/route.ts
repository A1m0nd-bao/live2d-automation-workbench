export const runtime = 'edge';

/** Exposes only Supabase's browser-safe URL and publishable key. */
export async function GET() {
  const supabaseUrl = (process.env.SUPABASE_URL ?? '').trim().replace(/\/$/, '');
  const supabasePublishableKey = (process.env.SUPABASE_PUBLISHABLE_KEY ?? '').trim();
  if (!supabaseUrl.startsWith('https://') || !supabasePublishableKey)
    return Response.json({ configured: false }, {
      status: 503,
      headers: { 'Cache-Control': 'no-store' },
    });
  return Response.json({ supabaseUrl, supabasePublishableKey }, {
    headers: { 'Cache-Control': 'no-store' },
  });
}
