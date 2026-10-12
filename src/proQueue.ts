import { getDirectServiceConfig } from './serviceBridge';

export type ProRun = {
  id: string;
  pipeline?: 'psd-pose-variants-v1';
  status: 'running' | 'ready' | 'needs_attention';
  message: string;
  states: Array<{id: string; status: string; message: string; attempt: number; preview?: boolean}>;
};

export const PSD_POSE_PIPELINE = 'psd-pose-variants-v1' as const;
export const proRunPath = (runId: string, pipeline?: string) =>
  `${pipeline === PSD_POSE_PIPELINE ? '/pose-jobs' : '/jobs'}/${runId}`;

export async function proRequest<T>(path: string, body?: FormData): Promise<T> {
  const config = getDirectServiceConfig();
  if (!config) throw new Error('请连接常驻服务以恢复 Pro 队列；不会重新生图。');
  const response = await fetch(`${config.relayUrl}/pro${path}`, {
    method: body ? 'POST' : 'GET', body,
    headers: {'X-Morph-Device-Token': config.deviceToken},
    signal: AbortSignal.timeout(/\/(output|preview)$/.test(path) || path === '/pose-jobs' ? 120000 : 30000), cache: 'no-store',
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({})) as { detail?: unknown };
    throw new Error(typeof data.detail === 'string' ? data.detail : `Pro 队列 HTTP ${response.status}；请确认服务端已升级`);
  }
  return (/\/(output|preview)$/.test(path) ? response.arrayBuffer() : response.json()) as Promise<T>;
}
