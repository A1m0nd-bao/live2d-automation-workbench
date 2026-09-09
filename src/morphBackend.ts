import { createClient, type SupabaseClient } from '@supabase/supabase-js';

export type MorphUser = {
  id: string;
  email: string;
  role: 'admin' | 'creator';
};

type RuntimeConfig = { supabaseUrl: string; publishableKey: string };
let runtimeConfig: RuntimeConfig | null = null;
let client: SupabaseClient | null = null;

function configuredFromBuild(): RuntimeConfig | null {
  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
  const publishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
  if (typeof supabaseUrl !== 'string' || !supabaseUrl.trim().startsWith('https://')) return null;
  if (typeof publishableKey !== 'string' || !publishableKey.trim()) return null;
  return { supabaseUrl: supabaseUrl.trim().replace(/\/$/, ''), publishableKey: publishableKey.trim() };
}

export function backendConfig() { return runtimeConfig ?? configuredFromBuild(); }

function supabase() {
  const config = backendConfig();
  if (!config) throw new Error('生产工作区尚未配置。');
  if (!client)
    client = createClient(config.supabaseUrl, config.publishableKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    });
  return client;
}

/** GitHub Pages uses VITE_ at build time; the private preview reads browser-safe values at runtime. */
export async function loadBackendConfig() {
  if (backendConfig()) return backendConfig();
  try {
    const response = await fetch('/api/production-config', { cache: 'no-store' });
    if (!response.ok) return null;
    const body = await response.json() as { supabaseUrl?: unknown; supabasePublishableKey?: unknown };
    if (typeof body.supabaseUrl !== 'string' || !body.supabaseUrl.trim().startsWith('https://')) return null;
    if (typeof body.supabasePublishableKey !== 'string' || !body.supabasePublishableKey.trim()) return null;
    runtimeConfig = {
      supabaseUrl: body.supabaseUrl.trim().replace(/\/$/, ''),
      publishableKey: body.supabasePublishableKey.trim(),
    };
    return runtimeConfig;
  } catch { return null; }
}

function safeFilename(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 180) || 'artifact.bin';
}

async function userProfile(): Promise<MorphUser | null> {
  const api = supabase();
  const { data: { user }, error } = await api.auth.getUser();
  if (error || !user?.email) return null;
  const { data: profile, error: profileError } = await api
    .from('profiles').select('id, email, role').eq('id', user.id).maybeSingle();
  if (profileError) throw new Error('生产工作区尚未完成数据初始化。');
  if (!profile) return null;
  return { id: profile.id, email: profile.email, role: profile.role === 'admin' ? 'admin' : 'creator' };
}

export async function currentBackendUser() { return userProfile(); }

/** Request an invitation-only email sign-in link using Supabase's free default mailer. */
export async function loginWithAccess(email: string) {
  const address = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) throw new Error('请输入有效的工作邮箱。');
  const { error } = await supabase().auth.signInWithOtp({
    email: address,
    options: { shouldCreateUser: false, emailRedirectTo: window.location.origin },
  });
  if (error) throw new Error(error.message);
}

export async function signOutBackend() {
  if (!backendConfig()) return;
  await supabase().auth.signOut();
}

export async function createBackendProject(input: { title: string; inputMode: string; metadata: Record<string, unknown> }) {
  const project = {
    id: crypto.randomUUID(), title: input.title.trim().slice(0, 160), input_mode: input.inputMode,
    metadata: input.metadata,
  };
  const { data, error } = await supabase().from('projects').insert(project).select('id').single();
  if (error) throw new Error(error.message);
  return { project: { id: data.id as string } };
}

export async function uploadBackendArtifact(input: { projectId: string; kind: string; filename: string; blob: Blob; retentionClass: 'permanent' | 'diagnostic' }) {
  const id = crypto.randomUUID();
  const filename = safeFilename(input.filename);
  const storagePath = `${input.projectId}/${input.kind}/${id}-${filename}`;
  const api = supabase();
  const { error: uploadError } = await api.storage.from('morph-assets').upload(storagePath, input.blob, {
    contentType: input.blob.type || 'application/octet-stream', upsert: false,
  });
  if (uploadError) throw new Error(uploadError.message);
  const { error: artifactError } = await api.from('artifacts').insert({
    id, project_id: input.projectId, kind: input.kind, storage_path: storagePath, filename,
    mime_type: input.blob.type || 'application/octet-stream', byte_size: input.blob.size,
    retention_class: input.retentionClass,
    delete_after: input.retentionClass === 'diagnostic'
      ? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString() : null,
  });
  if (artifactError) {
    await api.storage.from('morph-assets').remove([storagePath]);
    throw new Error(artifactError.message);
  }
  return { artifact: { id, storageKey: storagePath } };
}
