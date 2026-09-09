export const runtime = 'edge';

/**
 * This exposes only the browser-safe Cloudflare Worker origin. Its R2/D1
 * bindings and bootstrap secret are never present in a frontend response.
 */
export async function GET() {
  const apiUrl = (process.env.MORPH_API_URL ?? '').trim().replace(/\/$/, '');
  if (!apiUrl.startsWith('https://'))
    return Response.json({ configured: false }, {
      status: 503,
      headers: { 'Cache-Control': 'no-store' },
    });
  return Response.json({ apiUrl }, {
    headers: { 'Cache-Control': 'no-store' },
  });
}
