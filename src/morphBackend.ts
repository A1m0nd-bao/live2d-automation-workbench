export type MorphUser = {
  id: string;
  email: string;
  role: 'admin' | 'creator';
  expiresAt: string;
};

type RuntimeConfig = { apiUrl: string };
const SESSION_KEY = 'morph.production.session.v1';
let runtimeConfig: RuntimeConfig | null = null;

function configuredFromBuild(): RuntimeConfig | null {
  const value = import.meta.env.VITE_MORPH_API_URL;
  if (typeof value !== 'string' || !value.trim().startsWith('https://')) return null;
  return { apiUrl: value.trim().replace(/\/$/, '') };
}

export function backendConfig() {
  return runtimeConfig ?? configuredFromBuild();
}

/** Private Sites read this public API address at runtime; GitHub Pages uses VITE_. */
export async function loadBackendConfig() {
  if (backendConfig()) return backendConfig();
  try {
    const response = await fetch('/api/production-config', { cache: 'no-store' });
    if (!response.ok) return null;
    const body = await response.json() as { apiUrl?: unknown };
    if (typeof body.apiUrl !== 'string' || !body.apiUrl.trim().startsWith('https://')) return null;
    runtimeConfig = { apiUrl: body.apiUrl.trim().replace(/\/$/, '') };
    return runtimeConfig;
  } catch {
    return null;
  }
}

function token() {
  try { return localStorage.getItem(SESSION_KEY) || ''; } catch { return ''; }
}
function storeToken(value: string | null) {
  try {
    if (value) localStorage.setItem(SESSION_KEY, value);
    else localStorage.removeItem(SESSION_KEY);
  } catch { /* unavailable browser storage is treated as a signed-out state */ }
}

async function request<T>(path: string, init: RequestInit = {}) {
  const config = backendConfig();
  if (!config) throw new Error('生产后端尚未配置。');
  const headers = new Headers(init.headers);
  const value = token();
  if (value) headers.set('Authorization', `Bearer ${value}`);
  const response = await fetch(`${config.apiUrl}${path}`, { ...init, headers });
  const contentType = response.headers.get('content-type') || '';
  const body = contentType.includes('application/json')
    ? await response.json().catch(() => ({})) as { error?: string }
    : { error: await response.text() };
  if (!response.ok) throw new Error(body.error || `服务返回 ${response.status}`);
  return body as T;
}

export async function currentBackendUser() {
  if (!token()) return null;
  try { return (await request<{ user: MorphUser }>('/v1/auth/me')).user; }
  catch { storeToken(null); return null; }
}

export async function loginWithAccess() {
  const config = backendConfig();
  if (!config) throw new Error('生产后端尚未配置。');
  const nonce = crypto.randomUUID();
  const popup = window.open(
    `${config.apiUrl}/v1/access/exchange?${new URLSearchParams({ return_origin: window.location.origin, nonce })}`,
    'morph-cloudflare-access',
    'popup,width=520,height=680',
  );
  if (!popup) throw new Error('浏览器拦截了邮箱登录窗口，请允许弹出窗口后重试。');
  return new Promise<MorphUser>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      window.removeEventListener('message', receive);
      reject(new Error('登录超时，请在登录窗口完成邮箱验证码。'));
    }, 5 * 60_000);
    const receive = (event: MessageEvent) => {
      if (event.origin !== config.apiUrl) return;
      const body = event.data as { channel?: string; nonce?: string; token?: string; user?: MorphUser } | null;
      if (body?.channel !== 'morph-access-v1' || body.nonce !== nonce || !body.token || !body.user) return;
      window.clearTimeout(timer);
      window.removeEventListener('message', receive);
      storeToken(body.token);
      resolve(body.user);
    };
    window.addEventListener('message', receive);
  });
}

export function signOutBackend() { storeToken(null); }

export async function createBackendProject(input: { title: string; inputMode: string; metadata: Record<string, unknown> }) {
  return request<{ project: { id: string } }>('/v1/projects', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
  });
}

export async function uploadBackendArtifact(input: { projectId: string; kind: string; filename: string; blob: Blob; retentionClass: 'permanent' | 'diagnostic' }) {
  const query = new URLSearchParams({ kind: input.kind, filename: input.filename, retention: input.retentionClass });
  return request<{ artifact: { id: string; storageKey: string } }>(`/v1/projects/${input.projectId}/assets?${query}`, {
    method: 'PUT', headers: { 'Content-Type': input.blob.type || 'application/octet-stream' }, body: input.blob,
  });
}
