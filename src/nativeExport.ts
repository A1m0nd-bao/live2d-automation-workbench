import {
  connectLocalRelay,
  getDirectServiceConfig,
  type DirectServiceConfig,
} from './serviceBridge';

async function checkNativeRelay(config: DirectServiceConfig) {
  const response = await fetch(`${config.relayUrl}/health`, {
    headers: { 'X-Morph-Device-Token': config.deviceToken },
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok)
    throw new Error(`桥接健康检查返回 ${response.status}`);
}

/**
 * Native export is device-bound, but it should not require a separate setup
 * step for Pro. Both standard and Pro call compileNative(), so discover the
 * loopback bridge here and keep the resulting device token scoped to the
 * current browser origin.
 */
export async function ensureNativeExportRelay(progress: (text: string) => void): Promise<DirectServiceConfig> {
  let config = getDirectServiceConfig();
  if (!config) {
    progress('正在自动发现本机原生导出桥接…');
    try {
      await connectLocalRelay();
      config = getDirectServiceConfig();
    } catch {
      throw new Error('未检测到可用的本机原生导出桥接。请启动桌面桥接后重试；CMO3 已保留。');
    }
  }
  if (!config)
    throw new Error('本机桥接未返回有效设备密钥；CMO3 已保留。');

  try {
    await checkNativeRelay(config);
    return config;
  } catch {
    // Loopback services can be restarted while the browser remains open.
    // Re-bootstrap once so a refreshed device token is picked up without
    // asking the user to repeat a standard/Pro-specific setup step.
    if (!/^http:\/\/(127\.0\.0\.1|localhost)(?::\d+)?$/.test(config.relayUrl))
      throw new Error('已保存的原生导出桥接当前不可用。请检查 Relay 服务后重试；CMO3 已保留。');
    progress('本机桥接未响应，正在重新连接…');
    try {
      await connectLocalRelay();
      config = getDirectServiceConfig();
      if (!config) throw new Error('设备密钥无效');
      await checkNativeRelay(config);
      return config;
    } catch {
      throw new Error('本机原生导出桥接未运行或健康检查失败。请启动桥接后重试；CMO3 已保留。');
    }
  }
}

export async function compileNative(cmo: Blob, progress: (text: string) => void, profile: 'standard' | 'pro-rig-v1' = 'standard'): Promise<Blob> {
  type NativeJob = { id: string; status: string; message: string; profile?: string };
  const config = await ensureNativeExportRelay(progress);
  const headers = { 'X-Morph-Device-Token': config.deviceToken };
  const request = async (path: string, init: RequestInit = {}) => {
    const r = await fetch(`${config.relayUrl}/native-export${path}`, { ...init, headers, signal: AbortSignal.timeout(60000) });
    if (!r.ok) { const error = await r.json().catch(() => ({})) as {detail?: string}; throw new Error(error.detail || `原生导出服务返回 ${r.status}`); }
    return r;
  };
  progress('提交 CMO3 到本机无界面导出器…');
  let job = await (await request(`/jobs?profile=${profile}`, {method:'POST', body:cmo})).json() as NativeJob;
  if (profile === 'pro-rig-v1' && job.profile !== profile)
    throw new Error('本机桥接尚未接入 Pro 嘴部与九向流程，请升级桥接后重试；不会将普通编译误报为 Pro 完成。');
  for (let i = 0; i < 600; i++) {
    progress(job.message);
    if (job.status === 'failed') throw new Error(job.message);
    if (job.status === 'succeeded') return (await request(`/jobs/${job.id}/output`)).blob();
    await new Promise(resolve => setTimeout(resolve, 2000));
    job = await (await request(`/jobs/${job.id}`)).json() as NativeJob;
  }
  throw new Error('编译仍在后台排队。CMO3 已保存，稍后再次生成会复用相同文件的任务。');
}
