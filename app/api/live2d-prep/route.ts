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
const IMAGE2_DEFAULT_MODEL = 'openai/gpt-image-2';
const IMAGE2_GATEWAY_URL = 'https://ai-gateway.vercel.sh/v1/images/edits';
type PrepProvider = 'doubao' | 'image2';

function json(body: unknown, status = 200) {
  return Response.json(body, {
    status,
    headers: { 'Cache-Control': 'no-store' },
  });
}

function arkKey() {
  return process.env.VOLCENGINE_ARK_API_KEY ?? '';
}

function image2Config() {
  return {
    key: process.env.AI_GATEWAY_API_KEY ?? '',
    model: process.env.IMAGE2_MODEL ?? IMAGE2_DEFAULT_MODEL,
  };
}

function availability(provider: PrepProvider) {
  if (provider === 'doubao')
    return {
      ready: Boolean(arkKey()),
      model: process.env.VOLCENGINE_ARK_MODEL || LIVE2D_PREP_MODEL,
      message: arkKey()
        ? '豆包 Seedream Live2D 预处理已就绪。'
        : '豆包生图尚未配置 VOLCENGINE_ARK_API_KEY。',
    };
  const config = image2Config();
  const ready = Boolean(config.key);
  return {
    ready,
    model: config.model,
    message: ready
      ? 'Image-2 Live2D 预处理已就绪。'
      : 'Image-2 尚未配置 AI_GATEWAY_API_KEY。',
  };
}

function providerFrom(value: FormDataEntryValue | null): PrepProvider {
  if (!value || value === 'doubao') return 'doubao';
  if (value === 'image2') return 'image2';
  throw new Error('不支持的生图提供方。');
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
  const doubao = availability('doubao');
  const image2 = availability('image2');
  return json(
    {
      ready: doubao.ready || image2.ready,
      providers: { doubao, image2 },
      message: [doubao, image2].filter((item) => item.ready).map((item) => item.message).join(' ') || '尚未配置可用的角色整理生图服务。',
    },
    doubao.ready || image2.ready ? 200 : 503,
  );
}

export async function POST(request: Request) {
  const form = await request.formData();
  const image = form.get('image');
  if (!(image instanceof File))
    return json({ error: '请提供 PNG 或 JPG 角色参考图。' }, 400);
  if (!['image/png', 'image/jpeg'].includes(image.type))
    return json({ error: '仅支持 PNG 或 JPG 图片。' }, 415);
  if (image.size > MAX_IMAGE_BYTES)
    return json({ error: '参考图最大 20 MB。' }, 413);

  let provider: PrepProvider;
  try {
    provider = providerFrom(form.get('provider'));
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : '生图提供方无效。' }, 400);
  }
  const selected = availability(provider);
  if (!selected.ready) return json({ error: selected.message }, 503);

  try {
    const input = await image.arrayBuffer();
    const response = provider === 'doubao'
      ? await fetch(ARK_URL, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${arkKey()}`,
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
        })
      : await requestImage2(image, input);
    if (!response.ok)
      return json({ error: await apiError(response) }, response.status);
    if (response.headers.get('Content-Type')?.toLowerCase().startsWith('image/')) {
      const output = await response.arrayBuffer();
      return imageResponse(output);
    }
    const payload = (await response.json()) as {
      data?: Array<{ b64_json?: string }>;
    };
    const encoded = payload.data?.[0]?.b64_json;
    if (!encoded) throw new Error(`${selected.model} 未返回图像。`);
    const output = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));
    return imageResponse(output.buffer);
  } catch (error) {
    return json(
      { error: error instanceof Error ? error.message : `${selected.model} 生图预处理失败。` },
      502,
    );
  }
}

async function requestImage2(image: File, input: ArrayBuffer) {
  const config = image2Config();
  return fetch(IMAGE2_GATEWAY_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: config.model,
      prompt: live2dPrepPrompt(),
      images: [{ image_url: `data:${image.type};base64,${base64(input)}` }],
      size: LIVE2D_PREP_SIZE,
      background: 'transparent',
      output_format: 'png',
      response_format: 'b64_json',
    }),
    signal: AbortSignal.timeout(180_000),
  });
}

function imageResponse(output: ArrayBuffer) {
  const mime = isPng(output)
    ? 'image/png'
    : isJpeg(output)
      ? 'image/jpeg'
      : null;
  if (!mime) throw new Error('生图服务返回的文件不是 PNG 或 JPEG。');
  return new Response(output, {
    headers: {
      'Content-Type': mime,
      'Content-Disposition': `attachment; filename="live2d-friendly.${mime === 'image/png' ? 'png' : 'jpg'}"`,
      'Cache-Control': 'no-store',
    },
  });
}
