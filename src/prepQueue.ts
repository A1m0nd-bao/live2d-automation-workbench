import { getDirectServiceConfig } from './serviceBridge';
import type { Live2dPrepProvider } from './live2dPrep';

export type PrepJob = {
  id: string; name: string; provider: Live2dPrepProvider;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'uncertain' | 'needs-review';
  quality?: {version?: string; status: string; reasons?: string[]; checks?: Record<string, string>};
  message: string; created_at: number; updated_at: number;
};

const BASE_REVIEW_CHECKS = ['full_body', 'frame_margin', 'identity', 'outfit', 'style', 'anatomy', 'pose', 'background'];
const REVIEW_SCHEMAS: Record<string, readonly string[]> = {
  'image-quality-v4': BASE_REVIEW_CHECKS,
  'image-quality-v5': [...BASE_REVIEW_CHECKS, 'face_front'],
};

/** Shared by candidate recovery and the final split submission guard. */
export function prepReviewBlockReason(job: Pick<PrepJob, 'status' | 'quality'>): string | undefined {
  const report = job.quality;
  if (job.status !== 'succeeded' || report?.status !== 'passed')
    return report?.reasons?.join('；') || '生成图尚未通过服务端视觉检查，已阻止自动拆层。';
  const checks = REVIEW_SCHEMAS[report.version ?? ''];
  if (!checks)
    return `无法识别服务端质检版本（${report.version || '缺失'}），已阻止拆层；请更新工作台，不必重新生图。`;
  if (!report.checks || checks.some(check => report.checks?.[check] !== 'pass') || Object.values(report.checks).some(value => value !== 'pass'))
    return '服务端质检项目不完整或含未通过项，已阻止拆层；请复核现有图片，不必重新生图。';
  return undefined;
}

export async function prepRequest<T>(path: string, body?: FormData): Promise<T> {
  const config = getDirectServiceConfig();
  if (!config) throw new Error('请先点「接入本机桥接」或配置常驻 Relay；生图不再使用旧网站的登录弹窗。');
  let response: Response;
  try {
    response = await fetch(`${config.relayUrl}/prep${path}`, {
      method: body ? 'POST' : 'GET', body,
      headers: { 'X-Morph-Device-Token': config.deviceToken },
      signal: AbortSignal.timeout(path.endsWith('/review') ? 150_000 : body ? 30_000 : 15_000),
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

export function recoverPrepState<T extends { prepJobId?: string; prepState?: string; prepMessage?: string; remoteJobId?: string }>(task: T): T {
  if (task.prepJobId && ['succeeded', 'needs-review'].includes(task.prepState ?? '') && !task.remoteJobId) {
    return { ...task, prepState: 'queued', prepMessage: '正在核对当前版本的生图检查结果；不会重新生成。' };
  }
  if (!['queued', 'running', 'connecting'].includes(task.prepState ?? '')) return task;
  return { ...task, prepState: task.prepJobId ? 'queued' : 'failed', prepMessage: task.prepJobId
    ? '正在恢复服务端生图状态；不会重新生成。'
    : '旧版连接已中断，没有可恢复的服务端生图编号。请接入常驻桥接后重新发起；旧请求是否扣费需向提供方确认。' };
}
