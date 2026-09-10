import { getDirectServiceConfig } from './serviceBridge';
import type { Live2dPrepProvider } from './live2dPrep';

export type PrepJob = {
  id: string; name: string; provider: Live2dPrepProvider;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'uncertain';
  message: string; created_at: number; updated_at: number;
};

export async function prepRequest<T>(path: string, body?: FormData): Promise<T> {
  const config = getDirectServiceConfig();
  if (!config) throw new Error('请先点「接入本机桥接」或配置常驻 Relay；生图不再使用旧网站的登录弹窗。');
  let response: Response;
  try {
    response = await fetch(`${config.relayUrl}/prep${path}`, {
      method: body ? 'POST' : 'GET', body,
      headers: { 'X-Morph-Device-Token': config.deviceToken },
      signal: AbortSignal.timeout(body ? 30_000 : 15_000),
      cache: 'no-store',
    });
  } catch {
    throw new Error('暂时无法连接常驻生图服务。已提交的任务不会因此重跑；请确认桥接运行及浏览器本地网络访问权限，再点「查询／恢复生图任务」。');
  }
  if (!response.ok) {
    const data = await response.json().catch(() => ({})) as { detail?: unknown };
    const error = new Error(typeof data.detail === 'string' ? data.detail : `生图队列返回 HTTP ${response.status}`);
    Object.assign(error, { status: response.status });
    throw error;
  }
  return (path.endsWith('/output') ? response.arrayBuffer() : response.json()) as Promise<T>;
}

export async function submitPrep(jobId: string, image: File, provider: Live2dPrepProvider, name: string) {
  const form = new FormData();
  form.append('job_id', jobId); form.append('image', image);
  form.append('provider', provider); form.append('name', name);
  return prepRequest<PrepJob>('/jobs', form);
}

export function recoverPrepState<T extends { prepJobId?: string; prepState?: string; prepMessage?: string }>(task: T): T {
  if (!['queued', 'running', 'connecting'].includes(task.prepState ?? '')) return task;
  return { ...task, prepState: task.prepJobId ? 'queued' : 'failed', prepMessage: task.prepJobId
    ? '正在恢复服务端生图状态；不会重新生成。'
    : '旧版连接已中断，没有可恢复的服务端生图编号。请接入常驻桥接后重新发起；旧请求是否扣费需向提供方确认。' };
}
