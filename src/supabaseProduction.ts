import { createClient, type Session, type SupabaseClient } from '@supabase/supabase-js';

/** Only the publishable Supabase key belongs in a browser build. */
export type ProductionConfig = { url: string; publishableKey: string };

function value(name: 'VITE_SUPABASE_URL' | 'VITE_SUPABASE_PUBLISHABLE_KEY') {
  const candidate = import.meta.env[name];
  return typeof candidate === 'string' ? candidate.trim() : '';
}

export function productionConfig(): ProductionConfig | null {
  if (runtimeConfig) return runtimeConfig;
  const url = value('VITE_SUPABASE_URL').replace(/\/$/, '');
  const publishableKey = value('VITE_SUPABASE_PUBLISHABLE_KEY');
  if (!url.startsWith('https://') || !publishableKey) return null;
  return { url, publishableKey };
}

let runtimeConfig: ProductionConfig | null = null;
let client: SupabaseClient | null = null;

/** Private Sites can read browser-safe values at runtime; static Pages uses VITE_. */
export async function loadProductionConfig() {
  if (productionConfig()) return productionConfig();
  try {
    const response = await fetch('/api/production-config', { cache: 'no-store' });
    if (!response.ok) return null;
    const value = await response.json() as { url?: unknown; publishableKey?: unknown };
    if (typeof value.url !== 'string' || typeof value.publishableKey !== 'string') return null;
    const url = value.url.trim().replace(/\/$/, '');
    const publishableKey = value.publishableKey.trim();
    if (!url.startsWith('https://') || !publishableKey) return null;
    runtimeConfig = { url, publishableKey };
    return runtimeConfig;
  } catch {
    return null;
  }
}

export function productionClient() {
  const config = productionConfig();
  if (!config) return null;
  if (!client)
    client = createClient(config.url, config.publishableKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    });
  return client;
}

export async function currentProductionSession(): Promise<Session | null> {
  const supabase = productionClient();
  if (!supabase) return null;
  const { data, error } = await supabase.auth.getSession();
  if (error) throw error;
  return data.session;
}

/** Invite-only passwordless sign-in; unknown addresses cannot self-register. */
export async function sendProductionMagicLink(email: string) {
  const supabase = productionClient();
  if (!supabase) throw new Error('生产账户服务尚未配置。');
  const { error } = await supabase.auth.signInWithOtp({
    email: email.trim(),
    options: {
      shouldCreateUser: false,
      emailRedirectTo: `${window.location.origin}${window.location.pathname}`,
    },
  });
  if (error) throw error;
}

export async function signOutProduction() {
  const supabase = productionClient();
  if (!supabase) return;
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
}
