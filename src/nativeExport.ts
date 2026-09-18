import { getDirectServiceConfig } from './serviceBridge';
export async function compileNative(cmo: Blob, progress: (text: string) => void): Promise<Blob> {
  const config = getDirectServiceConfig();
  if (!config) throw new Error('CMO3 已保存；请先接入本机桥接，再进行原生导出。');
  const headers = { 'X-Morph-Device-Token': config.deviceToken };
  const request = async (path: string, init: RequestInit = {}) => {
    const r = await fetch(`${config.relayUrl}/native-export${path}`, { ...init, headers, signal: AbortSignal.timeout(60000) });
    if (!r.ok) { const error = await r.json().catch(() => ({})); throw new Error(error.detail || `原生导出服务返回 ${r.status}`); }
    return r;
  };
  progress('提交 CMO3 到本机无界面导出器…');
  let job = await (await request('/jobs', {method:'POST', body:cmo})).json();
  for (let i = 0; i < 180; i++) {
    progress(job.message);
    if (job.status === 'failed') throw new Error(job.message);
    if (job.status === 'succeeded') return (await request(`/jobs/${job.id}/output`)).blob();
    await new Promise(resolve => setTimeout(resolve, 2000));
    job = await (await request(`/jobs/${job.id}`)).json();
  }
  throw new Error('编译仍在后台排队。CMO3 已保存，稍后再次生成会复用相同文件的任务。');
}
