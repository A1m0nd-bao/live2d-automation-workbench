import {
  isPng,
  LIVE2D_PREP_MODEL,
  LIVE2D_PREP_SIZE,
  live2dPrepPrompt,
} from '../../../src/live2dPrep';

export const runtime = 'edge';
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

function json(body: unknown, status = 200) {
  return Response.json(body, {
    status,
    headers: { 'Cache-Control': 'no-store' },
  });
}

function apiKey() {
  return process.env.OPENAI_API_KEY ?? '';
}

async function apiError(response: Response) {
  const text = await response.text();
  try {
    const body = JSON.parse(text) as {
      error?: { message?: string };
      message?: string;
    };
    return body.error?.message ?? body.message ?? text;
  } catch {
    return text || `Image service returned HTTP ${response.status}`;
  }
}

export async function GET() {
  const ready = Boolean(apiKey());
  return json(
    {
      ready,
      model: LIVE2D_PREP_MODEL,
      message: ready
        ? 'Image 2 预处理已就绪。'
        : 'Image 2 尚未配置 OPENAI_API_KEY。',
    },
    ready ? 200 : 503,
  );
}

export async function POST(request: Request) {
  const key = apiKey();
  if (!key) return json({ error: 'Image 2 尚未配置 OPENAI_API_KEY。' }, 503);
  const form = await request.formData();
  const image = form.get('image');
  if (!(image instanceof File))
    return json({ error: '请提供 PNG 或 JPG 角色参考图。' }, 400);
  if (!['image/png', 'image/jpeg'].includes(image.type))
    return json({ error: '仅支持 PNG 或 JPG 图片。' }, 415);
  if (image.size > MAX_IMAGE_BYTES)
    return json({ error: '参考图最大 20 MB。' }, 413);

  const upstream = new FormData();
  upstream.append('model', LIVE2D_PREP_MODEL);
  upstream.append('image', image, image.name || 'reference.png');
  upstream.append('prompt', live2dPrepPrompt());
  upstream.append('size', LIVE2D_PREP_SIZE);
  upstream.append('quality', 'medium');
  upstream.append('background', 'opaque');
  upstream.append('output_format', 'png');

  try {
    const response = await fetch('https://api.openai.com/v1/images/edits', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}` },
      body: upstream,
      signal: AbortSignal.timeout(180_000),
    });
    if (!response.ok)
      return json({ error: await apiError(response) }, response.status);
    const payload = (await response.json()) as {
      data?: Array<{ b64_json?: string }>;
    };
    const encoded = payload.data?.[0]?.b64_json;
    if (!encoded) throw new Error('Image 2 未返回 PNG 图像。');
    const bytes = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));
    if (!isPng(bytes.buffer)) throw new Error('Image 2 返回的文件不是 PNG。');
    return new Response(bytes, {
      headers: {
        'Content-Type': 'image/png',
        'Content-Disposition': 'attachment; filename="live2d-friendly.png"',
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    return json(
      {
        error: error instanceof Error ? error.message : 'Image 2 预处理失败。',
      },
      502,
    );
  }
}
