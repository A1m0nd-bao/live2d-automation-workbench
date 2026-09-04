export const runtime = 'edge';

const API_BASE = 'https://studio-ljsabc-see-through.api-inference.modelscope.net';

type JsonRecord = Record<string, unknown>;

function json(body: unknown, status = 200) {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}

function token() {
  return process.env.MODELSCOPE_API_TOKEN ?? process.env.MODELSCOPE_TOKEN ?? '';
}

function apiName() {
  return process.env.SEE_THROUGH_API_NAME ?? '';
}

function inputTemplate() {
  const raw = process.env.SEE_THROUGH_INPUT_TEMPLATE ?? '["$image"]';
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : ['$image'];
  } catch {
    return ['$image'];
  }
}

async function remote(path: string, init: RequestInit = {}) {
  return fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token()}`,
      ...(init.headers ?? {}),
    },
  });
}

async function errorText(response: Response) {
  const text = await response.text();
  try {
    const body = JSON.parse(text) as JsonRecord;
    const error = body.error as JsonRecord | string | undefined;
    if (typeof error === 'string') return error;
    if (error && typeof error === 'object' && typeof error.message === 'string') return error.message;
    if (typeof body.message === 'string') return body.message;
  } catch {
    // Keep the provider's plain-text response when it is not JSON.
  }
  return text || `ModelScope returned HTTP ${response.status}`;
}

function endpointNames(info: unknown) {
  if (!info || typeof info !== 'object') return [];
  const record = info as JsonRecord;
  const named = record.named_endpoints ?? record.namedEndpoints;
  if (named && typeof named === 'object') return Object.keys(named as JsonRecord);
  const endpoints = record.endpoints;
  if (Array.isArray(endpoints)) return endpoints.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const value = (item as JsonRecord).api_name ?? (item as JsonRecord).apiName;
    return typeof value === 'string' ? [value] : [];
  });
  return [];
}

function extractUploadedFile(value: unknown): unknown {
  if (Array.isArray(value)) return value[0];
  if (value && typeof value === 'object') {
    const record = value as JsonRecord;
    for (const key of ['files', 'data', 'value']) {
      const candidate = record[key];
      if (Array.isArray(candidate)) return candidate[0];
    }
  }
  return value;
}

export async function GET(request: Request) {
  if (!token()) {
    return json({ ready: false, reason: 'missing_token', message: '管理员尚未配置 ModelScope API Token。' }, 503);
  }

  const url = new URL(request.url);
  const eventId = url.searchParams.get('eventId');
  const configuredApiName = apiName();

  if (eventId) {
    if (!configuredApiName) return json({ ready: false, reason: 'missing_api_name' }, 503);
    const response = await remote(`/gradio_api/call/${encodeURIComponent(configuredApiName)}/${encodeURIComponent(eventId)}`, {
      headers: { Accept: 'text/event-stream' },
    });
    if (!response.ok) return json({ error: await errorText(response) }, response.status);
    return new Response(response.body, {
      headers: {
        'Content-Type': response.headers.get('Content-Type') ?? 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    });
  }

  const info = await remote('/gradio_api/info');
  if (!info.ok) return json({ ready: false, reason: 'provider_error', message: await errorText(info) }, info.status);
  const body = await info.json();
  return json({
    ready: Boolean(configuredApiName),
    configuredApiName: configuredApiName || null,
    availableEndpoints: endpointNames(body),
    message: configuredApiName ? 'See-Through API 已就绪。' : 'Token 已验证；仍需选择 See-Through 的 Gradio API endpoint。',
  });
}

export async function POST(request: Request) {
  if (!token()) return json({ error: '管理员尚未配置 ModelScope API Token。' }, 503);
  const configuredApiName = apiName();
  if (!configuredApiName) return json({ error: '尚未设置 SEE_THROUGH_API_NAME。请先完成 API endpoint 配置。' }, 503);

  const form = await request.formData();
  const image = form.get('image');
  if (!(image instanceof File)) return json({ error: '请提供 PNG 或 JPG 角色参考图。' }, 400);
  if (!['image/png', 'image/jpeg'].includes(image.type)) return json({ error: '仅支持 PNG 或 JPG 图片。' }, 415);

  const uploadForm = new FormData();
  uploadForm.append('files', image, image.name);
  const upload = await remote('/gradio_api/upload', { method: 'POST', body: uploadForm });
  if (!upload.ok) return json({ error: await errorText(upload) }, upload.status);
  const uploaded = extractUploadedFile(await upload.json());
  if (!uploaded) return json({ error: 'ModelScope 未返回可用的上传文件标识。' }, 502);

  const data = inputTemplate().map((value) => value === '$image' ? uploaded : value);
  const job = await remote(`/gradio_api/call/${encodeURIComponent(configuredApiName)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data }),
  });
  if (!job.ok) return json({ error: await errorText(job) }, job.status);
  const result = await job.json() as JsonRecord;
  const eventId = result.event_id ?? result.eventId;
  if (typeof eventId !== 'string') return json({ error: 'ModelScope 未返回任务编号。', provider: result }, 502);
  return json({ eventId, status: 'submitted', message: '已提交到 See-Through，完成后可登记生成的 PSD。' }, 202);
}
