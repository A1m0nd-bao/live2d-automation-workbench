export const runtime = 'edge';

/**
 * This returns only Supabase's browser-safe values. The service-role key is
 * deliberately not read here and remains confined to worker/API environments.
 */
export async function GET() {
  const url = (process.env.SUPABASE_URL ?? '').trim().replace(/\/$/, '');
  const publishableKey = (process.env.SUPABASE_PUBLISHABLE_KEY ?? '').trim();
  if (!url.startsWith('https://') || !publishableKey)
    return Response.json({ configured: false }, {
      status: 503,
      headers: { 'Cache-Control': 'no-store' },
    });
  return Response.json({ url, publishableKey }, {
    headers: { 'Cache-Control': 'no-store' },
  });
}
