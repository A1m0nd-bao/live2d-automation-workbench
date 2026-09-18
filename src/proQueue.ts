import { getDirectServiceConfig } from './serviceBridge';

export type ProRun = {
  id: string;
  status: 'running' | 'ready' | 'needs_attention';
  message: string;
  states: Array<{id: string; status: string; message: string; attempt: number}>;
};

export async function proRequest<T>(path: string, body?: FormData): Promise<T> {
  const config = getDirectServiceConfig();
  if (!config) throw new Error('请连接常驻服务以恢复 Pro 队列；不会重新生图。');
  const response = await fetch(`${config.relayUrl}/pro${path}`, {
    method: body ? 'POST' : 'GET', body,
    headers: {'X-Morph-Device-Token': config.deviceToken},
    signal: AbortSignal.timeout(path.endsWith('/output') ? 120000 : 30000), cache: 'no-store',
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(typeof data.detail === 'string' ? data.detail : `Pro 队列 HTTP ${response.status}；请确认服务端已升级`);
  }
  return (path.endsWith('/output') ? response.arrayBuffer() : response.json()) as Promise<T>;
}
