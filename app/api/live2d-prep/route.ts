import {
  isJpeg,
  isPng,
  LIVE2D_PREP_MODEL,
  LIVE2D_PREP_SIZE,
  live2dPrepPrompt,
} from '../../../src/live2dPrep';

export const runtime = 'edge';
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const ARK_URL = 'https://ark.cn-beijing.volces.com/api/v3/images/generations';

function json(body: unknown, status = 200) {
  return Response.json(body, {
    status,
    headers: { 'Cache-Control': 'no-store' },
  });
}

function arkKey() {
  return process.env.VOLCENGINE_ARK_API_KEY ?? '';
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
    return text || `图像服务返回 HTTP ${response.status}`;
  }
}

function base64(bytes: ArrayBuffer) {
  const view = new Uint8Array(bytes);
  let text = '';
  for (let start = 0; start < view.length; start += 0x8000)
    text += String.fromCharCode(...view.subarray(start, start + 0x8000));
  return btoa(text);
}

export async function GET() {
  const ready = Boolean(arkKey());
  return json(
    {
      ready,
      model: LIVE2D_PREP_MODEL,
      message: ready
        ? '豆包 Seedream Live2D 预处理已就绪。'
        : '豆包生图尚未配置 VOLCENGINE_ARK_API_KEY。',
    },
    ready ? 200 : 503,
  );
}

export async function POST(request: Request) {
  const key = arkKey();
  if (!key)
    return json({ error: '豆包生图尚未配置 VOLCENGINE_ARK_API_KEY。' }, 503);
  const form = await request.formData();
  const image = form.get('image');
  if (!(image instanceof File))
    return json({ error: '请提供 PNG 或 JPG 角色参考图。' }, 400);
  if (!['image/png', 'image/jpeg'].includes(image.type))
    return json({ error: '仅支持 PNG 或 JPG 图片。' }, 415);
  if (image.size > MAX_IMAGE_BYTES)
    return json({ error: '参考图最大 20 MB。' }, 413);

  try {
    const input = await image.arrayBuffer();
    const response = await fetch(ARK_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: process.env.VOLCENGINE_ARK_MODEL || LIVE2D_PREP_MODEL,
        prompt: live2dPrepPrompt(),
        image: [`data:${image.type};base64,${base64(input)}`],
        size: LIVE2D_PREP_SIZE,
        sequential_image_generation: 'disabled',
        response_format: 'b64_json',
        watermark: false,
      }),
      signal: AbortSignal.timeout(180_000),
    });
    if (!response.ok)
      return json({ error: await apiError(response) }, response.status);
    const payload = (await response.json()) as {
      data?: Array<{ b64_json?: string }>;
    };
    const encoded = payload.data?.[0]?.b64_json;
    if (!encoded) throw new Error('豆包生图未返回图像。');
    const output = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));
    const mime = isPng(output.buffer)
      ? 'image/png'
      : isJpeg(output.buffer)
        ? 'image/jpeg'
        : null;
    if (!mime) throw new Error('豆包生图返回的文件不是 PNG 或 JPEG。');
    return new Response(output, {
      headers: {
        'Content-Type': mime,
        'Content-Disposition': `attachment; filename="live2d-friendly.${mime === 'image/png' ? 'png' : 'jpg'}"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    return json(
      { error: error instanceof Error ? error.message : '豆包生图预处理失败。' },
      502,
    );
  }
}
