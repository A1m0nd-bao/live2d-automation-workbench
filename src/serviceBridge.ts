export const SERVICE_ORIGIN =
  'https://morph-live2d-workbench.shehaoli.chatgpt.site';
const CHANNEL = 'morph-service-v1';
const DIRECT_SERVICE_STORAGE = 'morph.direct-relay.v1';
export type DirectServiceConfig = { relayUrl: string; deviceToken: string };
type Pending = {
  resolve: (data: unknown) => void;
  reject: (error: Error) => void;
  timer: number;
};
let popup: Window | null = null;
let nonce = '';
let listening = false;
const pending = new Map<string, Pending>();

function isRelayUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ||
      (url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost'));
  } catch {
    return false;
  }
}

export function getDirectServiceConfig(): DirectServiceConfig | null {
  try {
    const value = JSON.parse(localStorage.getItem(DIRECT_SERVICE_STORAGE) || 'null');
    if (
      value &&
      typeof value.relayUrl === 'string' &&
      typeof value.deviceToken === 'string' &&
      isRelayUrl(value.relayUrl) &&
      value.deviceToken.length >= 16
    )
      return { relayUrl: value.relayUrl.replace(/\/$/, ''), deviceToken: value.deviceToken };
  } catch {
    /* malformed browser-only configuration is ignored */
  }
  return null;
}

export function saveDirectServiceConfig(config: DirectServiceConfig | null) {
  if (!config) {
    localStorage.removeItem(DIRECT_SERVICE_STORAGE);
    return;
  }
  const relayUrl = config.relayUrl.trim().replace(/\/$/, '');
  if (!isRelayUrl(relayUrl))
    throw new Error('Relay 地址须为 HTTPS，或本机 http://127.0.0.1 / localhost。');
  if (config.deviceToken.trim().length < 16)
    throw new Error('设备密钥至少需要 16 个字符。');
  localStorage.setItem(DIRECT_SERVICE_STORAGE, JSON.stringify({
    relayUrl,
    deviceToken: config.deviceToken.trim(),
  }));
}

export function hasDirectServiceConfig() {
  return Boolean(getDirectServiceConfig());
}

export async function connectLocalRelay() {
  const relayUrl = 'http://127.0.0.1:7861';
  const response = await fetch(`${relayUrl}/local-bootstrap`, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error('未发现本机常驻桥接。');
  const data = await response.json() as { deviceToken?: string };
  saveDirectServiceConfig({ relayUrl, deviceToken: data.deviceToken || '' });
}

/**
 * Read the private, per-job upstream event stream from a direct relay.
 * This deliberately returns plain NDJSON instead of trying to expose relay
 * credentials or a generic upstream console to the public Pages site.
 */
export async function serviceDiagnostics(jobId: string): Promise<string> {
  const direct = getDirectServiceConfig();
  if (!direct)
    throw new Error('上游诊断仅在「接入本机桥接」或配置直连 Relay 后可查看。');
  if (!/^[a-f0-9]{32}$/.test(jobId)) throw new Error('任务 ID 无效。');
  const response = await fetch(`${direct.relayUrl}/jobs/${jobId}/diagnostics`, {
    headers: { 'X-Morph-Device-Token': direct.deviceToken },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as {
      detail?: string; error?: string; message?: string;
    };
    throw new Error(body.detail || body.error || body.message || `Relay 返回 ${response.status}`);
  }
  return response.text();
}

async function directServiceRequest<T>(
  config: DirectServiceConfig,
  command: Parameters<typeof serviceRequest>[0],
  payload: { image?: Blob; name?: string; jobId?: string; provider?: 'doubao' | 'image2' },
): Promise<T> {
  if (command === 'prepare')
    throw new Error('同步生图已停用，请使用常驻生图队列。');
  let path = '/health';
  let init: RequestInit = {
    headers: { 'X-Morph-Device-Token': config.deviceToken },
  };
  if (command === 'history') path = '/jobs?limit=40';
  if (command === 'prepHealth') path = '/prep/health';
  if (command === 'submit') {
    if (!payload.image) throw new Error('缺少参考图。');
    const form = new FormData();
    form.append('image', payload.image, payload.name || 'reference.png');
    path = `/jobs?name=${encodeURIComponent((payload.name || 'character').replace(/\.[^.]+$/, ''))}`;
    init = { method: 'POST', body: form, headers: { 'X-Morph-Device-Token': config.deviceToken } };
  }
  if (command === 'status' || command === 'output') {
    if (!/^[a-f0-9]{32}$/.test(payload.jobId || '')) throw new Error('任务 ID 无效。');
    path = `/jobs/${payload.jobId}${command === 'output' ? '/output' : ''}`;
  }
  const response = await fetch(`${config.relayUrl}${path}`, {
    ...init,
    signal: AbortSignal.timeout(command === 'submit' ? 90_000 : command === 'prepHealth' ? 15_000 : 45_000),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { detail?: string; error?: string; message?: string };
    throw new Error(body.detail || body.error || body.message || `Relay 返回 ${response.status}`);
  }
  if (command === 'output') return response.arrayBuffer() as Promise<T>;
  const result = await response.json() as { id?: string; [key: string]: unknown };
  if (command === 'submit')
    return { jobId: result.id, status: result.status, message: result.message } as T;
  if (command === 'health')
    return { ready: Boolean(result.ok), message: result.ok ? '直连常驻队列已就绪。' : '直连 Relay 缺少上游凭据。' } as T;
  return result as T;
}

export function connectService() {
  if (window.location.origin === SERVICE_ORIGIN) return;
  if (!listening) {
    window.addEventListener('message', (event) => {
      if (event.origin !== SERVICE_ORIGIN || event.source !== popup) return;
      const data = event.data;
      if (
        data?.channel !== CHANNEL ||
        data.nonce !== nonce ||
        typeof data.id !== 'string'
      )
        return;
      const item = pending.get(data.id);
      if (!item) return;
      window.clearTimeout(item.timer);
      pending.delete(data.id);
      if (data.error) item.reject(new Error(String(data.error)));
      else item.resolve(data.result);
    });
    listening = true;
  }
  if (popup && !popup.closed) {
    popup.focus();
    return;
  }
  nonce = crypto.randomUUID();
  popup = window.open(
    `${SERVICE_ORIGIN}/pages-bridge#${new URLSearchParams({ origin: window.location.origin, nonce })}`,
    'morph-private-service',
    'popup,width=560,height=520',
  );
  if (!popup)
    throw new Error('浏览器拦截了连接窗口，请允许本网站弹出窗口后再连接。');
}

export async function serviceRequest<T>(
  command:
    | 'health'
    | 'history'
    | 'prepare'
    | 'prepHealth'
    | 'submit'
    | 'status'
    | 'output',
  payload: { image?: Blob; name?: string; jobId?: string; provider?: 'doubao' | 'image2' } = {},
): Promise<T> {
  const direct = getDirectServiceConfig();
  if (command === 'prepare') throw new Error('同步生图已停用，请使用常驻生图队列。');
  if (command === 'prepHealth' && !direct)
    throw new Error('请接入本机桥接或配置常驻 Relay；生图不再依赖旧网站登录。');
  if (direct) return directServiceRequest<T>(direct, command, payload);
  if (window.location.origin === SERVICE_ORIGIN) {
    let path = '/api/see-through';
    let init: RequestInit = {};
    if (command === 'submit') {
      if (!payload.image) throw new Error('缺少参考图');
      const form = new FormData();
      form.append('image', payload.image, payload.name);
      init = { method: 'POST', body: form };
    }
    if (command === 'status' || command === 'output') {
      if (!/^[a-f0-9]{32}$/.test(payload.jobId || ''))
        throw new Error('任务 ID 无效');
      path += `?jobId=${payload.jobId}${command === 'output' ? '&output=1' : ''}`;
    }
    if (command === 'history') path += '?history=1';
    const response = await fetch(path, {
      ...init,
      signal: AbortSignal.timeout(80_000),
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as {
        error?: string;
        message?: string;
      };
      throw new Error(
        body.error || body.message || `服务返回 ${response.status}`,
      );
    }
    return command === 'output'
      ? (response.arrayBuffer() as Promise<T>)
      : response.json();
  }
  if (!popup || popup.closed)
    return Promise.reject(
      new Error('请先点击「连接任务服务」，完成登录并保持连接窗口打开。'),
    );
  const id = crypto.randomUUID();
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(
      () => {
        pending.delete(id);
        reject(
          new Error(
            command === 'submit'
              ? '未收到提交确认，请勿重复提交；请检查连接窗口和后台任务。'
              : '连接超时，请在连接窗口完成登录后重试。',
          ),
        );
      },
      90_000,
    );
    pending.set(id, { resolve: (data) => resolve(data as T), reject, timer });
    popup!.postMessage(
      { channel: CHANNEL, nonce, id, command, payload },
      SERVICE_ORIGIN,
    );
  });
}
