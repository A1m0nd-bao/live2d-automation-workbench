'use client';
/* oxlint-disable react/react-compiler -- Connection validation requires browser opener/hash after hydration. */
import { useEffect, useState } from 'react';

const PAGES_ORIGIN = 'https://a1m0nd-bao.github.io';
export default function PrivateBridgePage() {
  const [message, setMessage] = useState('正在建立连接…');
  useEffect(() => {
    const hash = new URLSearchParams(location.hash.slice(1));
    const origin = hash.get('origin');
    const nonce = hash.get('nonce');
    const local =
      location.hostname === 'localhost' || location.hostname === '127.0.0.1';
    const allowed =
      origin === PAGES_ORIGIN ||
      (local && /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin ?? ''));
    if (!allowed || !nonce || !window.opener) {
      setMessage('请从 GitHub Pages 工作台的「连接任务服务」按钮打开此窗口。');
      return;
    }
    let alive = true;
    const listener = async (event: MessageEvent) => {
      if (event.origin !== origin || event.source !== window.opener) return;
      const data = event.data;
      if (
        data?.channel !== 'morph-service-v1' ||
        data.nonce !== nonce ||
        typeof data.id !== 'string'
      )
        return;
      try {
        const { command, payload } = data;
        let path = '/api/see-through';
        let init: RequestInit = {};
        if (command === 'submit') {
          if (
            !(payload?.image instanceof Blob) ||
            payload.image.size > 20 * 1024 * 1024
          )
            throw new Error('参考图须小于 20 MB。');
          const form = new FormData();
          form.append('image', payload.image, payload.name || 'reference.png');
          init = { method: 'POST', body: form };
        } else if (command === 'status' || command === 'output') {
          if (!/^[a-f0-9]{32}$/.test(payload?.jobId ?? ''))
            throw new Error('任务 ID 无效。');
          path += `?jobId=${payload.jobId}${command === 'output' ? '&output=1' : ''}`;
        } else if (command !== 'health') {
          throw new Error('不支持的请求。');
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
            body.error || body.message || `任务服务返回 ${response.status}`,
          );
        }
        const result =
          command === 'output'
            ? await response.arrayBuffer()
            : await response.json();
        if (alive) {
          window.opener.postMessage(
            { channel: data.channel, nonce, id: data.id, result },
            origin,
            result instanceof ArrayBuffer ? [result] : [],
          );
          setMessage('已连接。你可以回到 GitHub Pages 工作台继续操作。');
        }
      } catch (error) {
        if (alive)
          window.opener.postMessage(
            {
              channel: data.channel,
              nonce,
              id: data.id,
              error: error instanceof Error ? error.message : '任务请求失败',
            },
            origin,
          );
      }
    };
    window.addEventListener('message', listener);
    setMessage('连接窗口已就绪。请回工作台点击「检查连接」。');
    return () => {
      alive = false;
      window.removeEventListener('message', listener);
    };
  }, []);
  return (
    <main
      style={{
        padding: 32,
        maxWidth: 560,
        margin: '0 auto',
        fontFamily: 'system-ui',
        lineHeight: 1.8,
      }}
    >
      <h1>任务服务连接</h1>
      <output>{message}</output>
      <p>
        此窗口使用现有登录身份访问私有任务服务，不会把 ModelScope
        密钥传给公开网页。
      </p>
      <p>
        请保持窗口打开。关闭它不会中断服务器上的拆分任务，但工作台需要重新连接才能查看结果。
      </p>
    </main>
  );
}
