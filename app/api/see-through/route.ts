export const runtime = 'edge';

type RelayJob = {
  id: string;
  name: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  message: string;
  queue_rank?: number | null;
  queue_eta_seconds?: number | null;
  output_psd?: string | null;
  error?: string | null;
  attempts: number;
};

function relayUrl() {
  return (process.env.SEE_THROUGH_RELAY_URL ?? '').replace(/\/$/, '');
}

function relayToken() {
  return process.env.MORPH_RELAY_TOKEN ?? '';
}

function modelScopeToken() {
  return process.env.MODELSCOPE_API_TOKEN ?? process.env.MODELSCOPE_TOKEN ?? '';
}

function json(body: unknown, status = 200) {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}

async function relay(path: string, init: RequestInit = {}) {
  const base = relayUrl();
  if (!base) throw new Error('服务端队列中转尚未配置。');
  return fetch(`${base}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${modelScopeToken()}`, 'X-Relay-Token': relayToken(), ...(init.headers ?? {}) },
  });
}

async function errorText(response: Response) {
  const text = await response.text();
  try {
    const body = JSON.parse(text) as { detail?: string; message?: string; error?: string };
    return body.detail ?? body.error ?? body.message ?? text;
  } catch {
    return text || `Relay returned HTTP ${response.status}`;
  }
}

export async function GET(request: Request) {
  const base = relayUrl();
  if (!base) return json({ ready: false, reason: 'missing_relay', message: '服务端常驻队列中转尚未部署。' }, 503);
  const url = new URL(request.url);
  const jobId = url.searchParams.get('jobId');
  try {
    if (!jobId) {
      const health = await relay('/health');
      if (!health.ok) return json({ ready: false, message: await errorText(health) }, health.status);
      const body = await health.json() as { ok?: boolean };
      return json({ ready: Boolean(body.ok), message: body.ok ? '服务端队列中转已就绪。' : '中转服务缺少上游凭据。' }, body.ok ? 200 : 503);
    }
    if (url.searchParams.get('output') === '1') {
      const output = await relay(`/jobs/${encodeURIComponent(jobId)}/output`);
      if (!output.ok) return json({ error: await errorText(output) }, output.status);
      return new Response(output.body, { headers: { 'Content-Type': output.headers.get('Content-Type') ?? 'application/octet-stream', 'Content-Disposition': output.headers.get('Content-Disposition') ?? 'attachment' } });
    }
    const job = await relay(`/jobs/${encodeURIComponent(jobId)}`);
    if (!job.ok) return json({ error: await errorText(job) }, job.status);
    return json(await job.json() as RelayJob);
  } catch (error) {
    return json({ ready: false, error: error instanceof Error ? error.message : '无法连接服务端队列中转。' }, 502);
  }
}

export async function POST(request: Request) {
  if (!relayUrl()) return json({ error: '服务端常驻队列中转尚未部署。' }, 503);
  const form = await request.formData();
  const image = form.get('image');
  if (!(image instanceof File)) return json({ error: '请提供 PNG 或 JPG 角色参考图。' }, 400);
  if (!['image/png', 'image/jpeg'].includes(image.type)) return json({ error: '仅支持 PNG 或 JPG 图片。' }, 415);
  const relayForm = new FormData();
  relayForm.append('image', image, image.name);
  try {
    const job = await relay(`/jobs?name=${encodeURIComponent(image.name.replace(/\.[^.]+$/, ''))}`, { method: 'POST', body: relayForm });
    if (!job.ok) return json({ error: await errorText(job) }, job.status);
    const body = await job.json() as RelayJob;
    return json({ jobId: body.id, eventId: body.id, status: body.status, message: body.message }, 202);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : '无法创建服务端任务。' }, 502);
  }
}
