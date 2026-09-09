import { createRemoteJWKSet, jwtVerify } from 'jose';

export interface Env {
  MORPH_DB: D1Database;
  MORPH_ASSETS: R2Bucket;
  MORPH_ALLOWED_ORIGINS: string;
  MORPH_ACCESS_TEAM_DOMAIN: string;
  MORPH_ACCESS_AUD: string;
  MORPH_ADMIN_EMAILS: string;
}

type Role = 'admin' | 'creator';
type User = { id: string; email: string; role: Role };
type Project = { id: string; owner_id: string; title: string; input_mode: string; status: string; metadata: string };
const encoder = new TextEncoder();
const validKinds = new Set(['source', 'prepared_image', 'psd', 'cmo3', 'moc3_bundle', 'stretch', 'report', 'preview', 'diagnostic']);
const validInputModes = new Set(['image', 'psd', 'stretch', 'pro']);

function allowedOrigins(env: Env) {
  return new Set(env.MORPH_ALLOWED_ORIGINS.split(',').map((value) => value.trim()).filter(Boolean));
}
function cors(request: Request, env: Env): Record<string, string> {
  const origin = request.headers.get('Origin');
  if (!origin || !allowedOrigins(env).has(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
    Vary: 'Origin',
  };
}
function json(request: Request, env: Env, body: unknown, status = 200) {
  return Response.json(body, { status, headers: { ...cors(request, env), 'Cache-Control': 'no-store' } });
}
function text(request: Request, env: Env, body: string, status = 200, headers: HeadersInit = {}) {
  return new Response(body, { status, headers: { ...cors(request, env), 'Cache-Control': 'no-store', ...headers } });
}
function cleanEmail(value: unknown) {
  if (typeof value !== 'string') return '';
  const email = value.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : '';
}
function safeFilename(value: string) {
  const output = value.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 180);
  return output || 'artifact.bin';
}
function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
async function sha256(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
async function audit(env: Env, actorId: string | null, action: string, entityType: string, entityId: string, detail: Record<string, unknown> = {}) {
  await env.MORPH_DB.prepare('insert into audit_events (actor_id, action, entity_type, entity_id, detail) values (?, ?, ?, ?, ?)')
    .bind(actorId, action, entityType, entityId, JSON.stringify(detail)).run();
}
async function sessionFor(request: Request, env: Env): Promise<User | null> {
  const header = request.headers.get('Authorization') || '';
  if (!header.startsWith('Bearer ')) return null;
  const tokenHash = await sha256(header.slice(7));
  const row = await env.MORPH_DB.prepare(
    `select u.id, u.email, u.role from sessions s join users u on u.id = s.user_id
     where s.token_hash = ? and s.expires_at > datetime('now')`,
  ).bind(tokenHash).first<User>();
  return row ?? null;
}
function isAdmin(user: User) { return user.role === 'admin'; }
async function ownsProject(env: Env, user: User, projectId: string) {
  const project = await env.MORPH_DB.prepare('select id, owner_id, title, input_mode, status, metadata from projects where id = ?')
    .bind(projectId).first<Project>();
  if (!project || (!isAdmin(user) && project.owner_id !== user.id)) return null;
  return project;
}
async function verifiedAccessEmail(request: Request, env: Env) {
  const token = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!token || !env.MORPH_ACCESS_TEAM_DOMAIN || !env.MORPH_ACCESS_AUD) return null;
  try {
    const issuer = env.MORPH_ACCESS_TEAM_DOMAIN.replace(/\/$/, '');
    const keys = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
    const { payload } = await jwtVerify(token, keys, { issuer, audience: env.MORPH_ACCESS_AUD });
    return cleanEmail(payload.email);
  } catch { return null; }
}
function accessPopup(request: Request, env: Env, token: string, user: User) {
  const origin = new URL(request.url).searchParams.get('return_origin') || '';
  const nonce = new URL(request.url).searchParams.get('nonce') || '';
  if (!allowedOrigins(env).has(origin) || !/^[a-zA-Z0-9-]{16,100}$/.test(nonce))
    return text(request, env, 'Invalid login handoff.', 400);
  const payload = JSON.stringify({ channel: 'morph-access-v1', nonce, token, user });
  const html = `<!doctype html><meta charset="utf-8"><title>登录成功</title><script>window.opener&&window.opener.postMessage(${payload},${JSON.stringify(origin)});window.close()</script><p>登录成功，可以关闭此窗口。</p>`;
  return text(request, env, html, 200, { 'Content-Type': 'text/html; charset=utf-8' });
}
async function accessExchange(request: Request, env: Env) {
  const email = await verifiedAccessEmail(request, env);
  if (!email) return text(request, env, 'Cloudflare Access verification failed.', 401);
  const isConfiguredAdmin = env.MORPH_ADMIN_EMAILS.split(',').map((value) => value.trim().toLowerCase()).includes(email);
  let user = await env.MORPH_DB.prepare('select id, email, role from users where email = ?').bind(email).first<User>();
  if (!user) {
    user = { id: crypto.randomUUID(), email, role: isConfiguredAdmin ? 'admin' : 'creator' };
    await env.MORPH_DB.prepare('insert into users (id, email, role) values (?, ?, ?)').bind(user.id, user.email, user.role).run();
    await audit(env, user.id, 'user.provisioned', 'user', user.id, { email, role: user.role });
  }
  const token = randomToken();
  await env.MORPH_DB.prepare(`insert into sessions (id, user_id, token_hash, expires_at) values (?, ?, ?, datetime('now', '+24 hours'))`)
    .bind(crypto.randomUUID(), user.id, await sha256(token)).run();
  return accessPopup(request, env, token, user);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(request, env) });
    const url = new URL(request.url);
    const path = url.pathname;
    if (path === '/health') return json(request, env, { ready: true, storage: 'r2', ledger: 'd1', auth: 'cloudflare-access' });
    if (path === '/v1/access/exchange' && request.method === 'GET') return accessExchange(request, env);

    const user = await sessionFor(request, env);
    if (!user) return json(request, env, { error: '请先通过邮箱完成登录。' }, 401);
    if (path === '/v1/auth/me' && request.method === 'GET') return json(request, env, { user });
    if (path === '/v1/auth/logout' && request.method === 'POST') {
      const header = request.headers.get('Authorization') || '';
      await env.MORPH_DB.prepare('delete from sessions where token_hash = ?').bind(await sha256(header.slice(7))).run();
      return json(request, env, { ok: true });
    }
    if (path === '/v1/projects' && request.method === 'GET') {
      const query = isAdmin(user)
        ? env.MORPH_DB.prepare('select id, owner_id, title, input_mode, status, metadata, created_at, updated_at from projects order by updated_at desc limit 200')
        : env.MORPH_DB.prepare('select id, owner_id, title, input_mode, status, metadata, created_at, updated_at from projects where owner_id = ? order by updated_at desc limit 200').bind(user.id);
      const projects = await query.all();
      return json(request, env, { projects: projects.results });
    }
    if (path === '/v1/projects' && request.method === 'POST') {
      const body = await request.json().catch(() => null) as { title?: unknown; inputMode?: unknown; metadata?: unknown } | null;
      const title = typeof body?.title === 'string' ? body.title.trim().slice(0, 160) : '';
      const inputMode = typeof body?.inputMode === 'string' ? body.inputMode : '';
      if (!title || !validInputModes.has(inputMode)) return json(request, env, { error: '项目名称或输入类型无效。' }, 400);
      const project = { id: crypto.randomUUID(), ownerId: user.id, title, inputMode, metadata: JSON.stringify(body?.metadata && typeof body.metadata === 'object' ? body.metadata : {}) };
      await env.MORPH_DB.prepare('insert into projects (id, owner_id, title, input_mode, metadata) values (?, ?, ?, ?, ?)')
        .bind(project.id, project.ownerId, project.title, project.inputMode, project.metadata).run();
      await audit(env, user.id, 'project.created', 'project', project.id, { title, inputMode });
      return json(request, env, { project: { id: project.id } }, 201);
    }
    const assetMatch = path.match(/^\/v1\/projects\/([0-9a-f-]{36})\/assets(?:\/([0-9a-f-]{36}))?$/);
    if (assetMatch) {
      const project = await ownsProject(env, user, assetMatch[1]);
      if (!project) return json(request, env, { error: '项目不存在或无权访问。' }, 404);
      if (!assetMatch[2] && request.method === 'GET') {
        const artifacts = await env.MORPH_DB.prepare('select id, kind, filename, mime_type, byte_size, retention_class, delete_after, created_at from artifacts where project_id = ? order by created_at desc').bind(project.id).all();
        return json(request, env, { artifacts: artifacts.results });
      }
      if (!assetMatch[2] && request.method === 'PUT') {
        const kind = url.searchParams.get('kind') || '';
        const filename = safeFilename(url.searchParams.get('filename') || '');
        const retentionClass = url.searchParams.get('retention') === 'diagnostic' ? 'diagnostic' : 'permanent';
        if (!validKinds.has(kind) || !request.body || !filename) return json(request, env, { error: '产物类型或文件大小无效。' }, 400);
        const id = crypto.randomUUID();
        const storageKey = `${project.id}/${kind}/${id}-${filename}`;
        const mimeType = request.headers.get('Content-Type') || 'application/octet-stream';
        const stored = await env.MORPH_ASSETS.put(storageKey, request.body, { httpMetadata: { contentType: mimeType } });
        const deleteAfter = retentionClass === 'diagnostic' ? "datetime('now', '+30 days')" : 'null';
        await env.MORPH_DB.prepare(`insert into artifacts (id, project_id, kind, storage_key, filename, mime_type, byte_size, retention_class, delete_after) values (?, ?, ?, ?, ?, ?, ?, ?, ${deleteAfter})`)
          .bind(id, project.id, kind, storageKey, filename, mimeType, stored.size, retentionClass).run();
        await audit(env, user.id, 'artifact.uploaded', 'artifact', id, { projectId: project.id, kind, filename, retentionClass });
        return json(request, env, { artifact: { id, storageKey } }, 201);
      }
      if (assetMatch[2] && request.method === 'GET') {
        const artifact = await env.MORPH_DB.prepare('select storage_key, filename, mime_type from artifacts where id = ? and project_id = ?')
          .bind(assetMatch[2], project.id).first<{ storage_key: string; filename: string; mime_type: string | null }>();
        if (!artifact) return json(request, env, { error: '产物不存在。' }, 404);
        const object = await env.MORPH_ASSETS.get(artifact.storage_key);
        if (!object) return json(request, env, { error: '对象存储中不存在该产物。' }, 404);
        return new Response(object.body, { headers: { ...cors(request, env), 'Content-Type': artifact.mime_type || 'application/octet-stream', 'Content-Disposition': `attachment; filename="${safeFilename(artifact.filename)}"`, 'Cache-Control': 'private, no-store' } });
      }
    }
    const reviewMatch = path.match(/^\/v1\/projects\/([0-9a-f-]{36})\/review$/);
    if (reviewMatch && request.method === 'POST') {
      if (!isAdmin(user)) return json(request, env, { error: '仅管理员可以审核交付。' }, 403);
      const project = await ownsProject(env, user, reviewMatch[1]);
      if (!project) return json(request, env, { error: '项目不存在。' }, 404);
      const body = await request.json().catch(() => null) as { status?: unknown; note?: unknown; checklist?: unknown } | null;
      const status = body?.status === 'approved' || body?.status === 'rejected' ? body.status : null;
      if (!status) return json(request, env, { error: '审核状态无效。' }, 400);
      const id = crypto.randomUUID();
      await env.MORPH_DB.batch([
        env.MORPH_DB.prepare('insert into reviews (id, project_id, status, checklist, note, reviewer_id, decided_at) values (?, ?, ?, ?, ?, ?, datetime(\'now\'))')
          .bind(id, project.id, status, JSON.stringify(body?.checklist && typeof body.checklist === 'object' ? body.checklist : {}), typeof body?.note === 'string' ? body.note.slice(0, 4000) : null, user.id),
        env.MORPH_DB.prepare('update projects set status = ?, updated_at = datetime(\'now\') where id = ?').bind(status === 'approved' ? 'approved' : 'revision_requested', project.id),
      ]);
      await audit(env, user.id, `review.${status}`, 'project', project.id, { reviewId: id });
      return json(request, env, { review: { id, status } }, 201);
    }
    return json(request, env, { error: '接口不存在。' }, 404);
  },
  async scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
    await env.MORPH_DB.prepare("delete from sessions where expires_at <= datetime('now')").run();
    const expired = await env.MORPH_DB.prepare("select id, storage_key from artifacts where delete_after is not null and delete_after <= datetime('now') limit 500").all<{ id: string; storage_key: string }>();
    for (const artifact of expired.results) {
      await env.MORPH_ASSETS.delete(artifact.storage_key);
      await env.MORPH_DB.prepare('delete from artifacts where id = ?').bind(artifact.id).run();
      await audit(env, null, 'artifact.retention_deleted', 'artifact', artifact.id);
    }
  },
};
