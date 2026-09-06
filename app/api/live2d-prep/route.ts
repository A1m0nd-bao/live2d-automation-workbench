import {
  isPng,
  LIVE2D_PREP_MODEL,
  LIVE2D_PREP_SIZE,
  live2dPrepPrompt,
} from '../../../src/live2dPrep';

export const runtime = 'edge';
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const ARK_URL = 'https://ark.cn-beijing.volces.com/api/v3/images/generations';

type TosConfig = {
  accessKey: string;
  secretKey: string;
  bucket: string;
  region: string;
  endpoint: string;
};

function json(body: unknown, status = 200) {
  return Response.json(body, {
    status,
    headers: { 'Cache-Control': 'no-store' },
  });
}

function arkKey() {
  return process.env.VOLCENGINE_ARK_API_KEY ?? '';
}

function tosConfig(): TosConfig | null {
  const accessKey = process.env.VOLCENGINE_TOS_ACCESS_KEY ?? '';
  const secretKey = process.env.VOLCENGINE_TOS_SECRET_KEY ?? '';
  const bucket = process.env.VOLCENGINE_TOS_BUCKET ?? '';
  const region = process.env.VOLCENGINE_TOS_REGION ?? 'cn-beijing';
  const endpoint =
    process.env.VOLCENGINE_TOS_ENDPOINT ?? `https://tos-${region}.volces.com`;
  return accessKey && secretKey && bucket
    ? { accessKey, secretKey, bucket, region, endpoint }
    : null;
}

function configMessage() {
  if (!arkKey()) return '豆包生图尚未配置 VOLCENGINE_ARK_API_KEY。';
  if (!tosConfig())
    return '豆包生图缺少临时参考图存储：请配置 VOLCENGINE_TOS_ACCESS_KEY、VOLCENGINE_TOS_SECRET_KEY 与 VOLCENGINE_TOS_BUCKET。';
  return '豆包 Seedream Live2D 预处理已就绪。';
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

function hex(bytes: ArrayBuffer) {
  return [...new Uint8Array(bytes)]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
}

const encode = (value: string) => new TextEncoder().encode(value);
const hash = async (value: string | ArrayBuffer) =>
  hex(
    await crypto.subtle.digest(
      'SHA-256',
      typeof value === 'string' ? encode(value) : value,
    ),
  );
const hmac = async (key: ArrayBuffer | Uint8Array, value: string) =>
  crypto.subtle.sign(
    'HMAC',
    await crypto.subtle.importKey(
      'raw',
      key as BufferSource,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    ),
    encode(value),
  );

async function signingKey(secret: string, stamp: string, region: string) {
  const date = await hmac(encode(`TOS4${secret}`), stamp);
  const regional = await hmac(date, region);
  const service = await hmac(regional, 'tos');
  return hmac(service, 'request');
}

function timestamps() {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
  return { amzDate: stamp, day: stamp.slice(0, 8) };
}

function endpoint(config: TosConfig) {
  const base = new URL(config.endpoint);
  return new URL(`https://${config.bucket}.${base.host}`);
}

function objectPath(key: string) {
  return `/${key.split('/').map(encodeURIComponent).join('/')}`;
}

async function signedTosRequest(
  config: TosConfig,
  method: 'PUT' | 'DELETE',
  key: string,
  body?: ArrayBuffer,
  contentType?: string,
) {
  const target = endpoint(config);
  const path = objectPath(key);
  const { amzDate, day } = timestamps();
  const payloadHash = await hash(body ?? new ArrayBuffer(0));
  const headers: Record<string, string> = {
    host: target.host,
    'x-tos-content-sha256': payloadHash,
    'x-tos-date': amzDate,
  };
  if (contentType) headers['content-type'] = contentType;
  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((name) => `${name}:${headers[name]}\n`).join('');
  const signedHeaders = names.join(';');
  const scope = `${day}/${config.region}/tos/request`;
  const canonical = `${method}\n${path}\n\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
  const signature = hex(
    await hmac(
      await signingKey(config.secretKey, day, config.region),
      `TOS4-HMAC-SHA256\n${amzDate}\n${scope}\n${await hash(canonical)}`,
    ),
  );
  headers.authorization = `TOS4-HMAC-SHA256 Credential=${config.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  // Fetch derives Host from the request URL. It is intentionally signed but not
  // set manually because Host is a restricted request header on edge runtimes.
  delete headers.host;
  const response = await fetch(new URL(path, target), {
    method,
    headers,
    body: body ? new Uint8Array(body) : undefined,
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok)
    throw new Error(
      `临时参考图存储失败（TOS HTTP ${response.status}）：${await apiError(response)}`,
    );
}

async function presignedReadUrl(config: TosConfig, key: string) {
  const target = endpoint(config);
  const path = objectPath(key);
  const { amzDate, day } = timestamps();
  const scope = `${day}/${config.region}/tos/request`;
  const query = new URLSearchParams({
    'X-Tos-Algorithm': 'TOS4-HMAC-SHA256',
    'X-Tos-Credential': `${config.accessKey}/${scope}`,
    'X-Tos-Date': amzDate,
    'X-Tos-Expires': '900',
    'X-Tos-SignedHeaders': 'host',
  });
  const canonicalQuery = [...query.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`)
    .join('&');
  const canonical = `GET\n${path}\n${canonicalQuery}\nhost:${target.host}\n\nhost\nUNSIGNED-PAYLOAD`;
  const signature = hex(
    await hmac(
      await signingKey(config.secretKey, day, config.region),
      `TOS4-HMAC-SHA256\n${amzDate}\n${scope}\n${await hash(canonical)}`,
    ),
  );
  return `${new URL(path, target).toString()}?${canonicalQuery}&X-Tos-Signature=${signature}`;
}

export async function GET() {
  const ready = Boolean(arkKey() && tosConfig());
  return json(
    { ready, model: LIVE2D_PREP_MODEL, message: configMessage() },
    ready ? 200 : 503,
  );
}

export async function POST(request: Request) {
  const key = arkKey();
  const tos = tosConfig();
  if (!key || !tos) return json({ error: configMessage() }, 503);
  const form = await request.formData();
  const image = form.get('image');
  if (!(image instanceof File))
    return json({ error: '请提供 PNG 或 JPG 角色参考图。' }, 400);
  if (!['image/png', 'image/jpeg'].includes(image.type))
    return json({ error: '仅支持 PNG 或 JPG 图片。' }, 415);
  if (image.size > MAX_IMAGE_BYTES)
    return json({ error: '参考图最大 20 MB。' }, 413);

  const suffix = image.type === 'image/png' ? 'png' : 'jpg';
  const objectKey = `live2d-prep/${crypto.randomUUID()}.${suffix}`;
  try {
    const input = await image.arrayBuffer();
    await signedTosRequest(tos, 'PUT', objectKey, input, image.type);
    const response = await fetch(ARK_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: process.env.VOLCENGINE_ARK_MODEL || LIVE2D_PREP_MODEL,
        prompt: live2dPrepPrompt(),
        image: [await presignedReadUrl(tos, objectKey)],
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
    if (!encoded) throw new Error('豆包生图未返回 PNG 图像。');
    const output = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));
    if (!isPng(output.buffer)) throw new Error('豆包生图返回的文件不是 PNG。');
    return new Response(output, {
      headers: {
        'Content-Type': 'image/png',
        'Content-Disposition': 'attachment; filename="live2d-friendly.png"',
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    return json(
      { error: error instanceof Error ? error.message : '豆包生图预处理失败。' },
      502,
    );
  } finally {
    await signedTosRequest(tos, 'DELETE', objectKey).catch(() => {});
  }
}
