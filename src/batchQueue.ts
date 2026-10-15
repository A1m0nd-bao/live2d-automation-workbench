import { getDirectServiceConfig, type SplitRoute } from './serviceBridge';

export type BatchSettings = { resolution: number; seed: number; split_limbs: boolean; friendly?: boolean; provider?: 'doubao' | 'image2'; upstream_route?: SplitRoute };
export const BATCH_DEFAULTS: BatchSettings = { resolution: 1024, seed: 42, split_limbs: true, friendly: true, provider: 'image2', upstream_route: 'yangzxo' };
export type BatchPosePlan = { states: string[]; provider: 'doubao' | 'image2' };
export type BatchDelivery = BatchPosePlan & {
  state: 'active' | 'paused' | 'completed' | 'blocked'; message: string;
  ready: number; needs_attention: number; running: number;
  resolved_base_count: number;
  items: Array<{ item_id: string; run_id: string; status: string; message: string }>;
  expressions: 'existing_runtime_presets_only'; mouth_modified: false;
};
export type SplitBatch = {
  id: string; name: string; created_at?: number;
  settings: BatchSettings; state: 'uploading' | 'active' | 'paused' | 'completed';
  total: number; succeeded: number; failed: number;
  friendly_succeeded?: number; uncertain?: number;
  pose_plan?: BatchPosePlan; // Browser upload-recovery snapshot, not base-queue settings.
  delivery?: BatchDelivery | null;
  items: Array<{ id: string; name: string; sha256: string; uploaded: boolean;
    status: 'uploading' | 'pending' | 'queued' | 'running' | 'succeeded' | 'failed' | 'friendly-queued' | 'friendly-running' | 'uncertain';
    message: string; filename: string }>;
};
export async function batchRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const config = getDirectServiceConfig();
  if (!config) throw new Error('请先接入本机桥接或配置 Relay。');
  const headers: Record<string, string> = {};
  new Headers(init.headers).forEach((value, key) => { headers[key] = value; });
  headers['X-Morph-Device-Token'] = config.deviceToken;
  const response = await fetch(`${config.relayUrl}/batches${path}`, {
    ...init, headers,
    signal: AbortSignal.timeout(path.endsWith('/output') ? 120_000 : 30_000), cache: 'no-store',
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({})) as { detail?: unknown };
    throw new Error(typeof data.detail === 'string' ? data.detail : response.status === 404
      ? 'Relay 尚未安装批处理接口，请更新本机桥接。' : `批处理服务返回 ${response.status}`);
  }
  return (path.endsWith('/output') ? response.blob() : response.json()) as Promise<T>;
}
export async function fingerprint(file: File) {
  const hash = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('');
}
export function validateBatchFiles(files: File[]) {
  if (!files.length || files.length > 100) throw new Error('每批选择 1–100 张 PNG/JPG。');
  for (const file of files) {
    if (!/\.(png|jpe?g)$/i.test(file.name)) throw new Error(`${file.name}：批量拆件仅接受 PNG/JPG。已有 PSD 请使用批量制作入口。`);
    if (file.size > 20 * 1024 * 1024 || !file.size) throw new Error(`${file.name}：单张图片须为 1 字节至 20 MB。`);
  }
}
