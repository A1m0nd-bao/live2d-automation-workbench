export const SERVICE_ORIGIN =
  'https://morph-live2d-workbench.shehaoli.chatgpt.site';
const CHANNEL = 'morph-service-v1';
type Pending = {
  resolve: (data: unknown) => void;
  reject: (error: Error) => void;
  timer: number;
};
let popup: Window | null = null;
let nonce = '';
let listening = false;
const pending = new Map<string, Pending>();

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
  command: 'health' | 'submit' | 'status' | 'output',
  payload: { image?: Blob; name?: string; jobId?: string } = {},
): Promise<T> {
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
    const response = await fetch(path, {
      ...init,
      signal: AbortSignal.timeout(80000),
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
    const timer = window.setTimeout(() => {
      pending.delete(id);
      reject(
        new Error(
          command === 'submit'
            ? '未收到提交确认，请勿重复提交；请检查连接窗口和后台任务。'
            : '连接超时，请在连接窗口完成登录后重试。',
        ),
      );
    }, 90000);
    pending.set(id, { resolve: (data) => resolve(data as T), reject, timer });
    popup!.postMessage(
      { channel: CHANNEL, nonce, id, command, payload },
      SERVICE_ORIGIN,
    );
  });
}
