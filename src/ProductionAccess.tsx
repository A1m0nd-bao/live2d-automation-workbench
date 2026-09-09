import { useEffect, useState } from 'react';
import { LogIn, LogOut, Mail, ShieldCheck } from 'lucide-react';
import type { MorphUser } from './morphBackend';
import { backendConfig, currentBackendUser, loadBackendConfig, loginWithAccess, signOutBackend } from './morphBackend';

type Props = { onUserChange: (user: MorphUser | null) => void };

/** Invite-only Cloudflare Access email OTP. No account is created here. */
export function ProductionAccess({ onUserChange }: Props) {
  const [configured, setConfigured] = useState(Boolean(backendConfig()));
  const [user, setUser] = useState<MorphUser | null>(null);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => { void loadBackendConfig().then((config) => setConfigured(Boolean(config))); }, []);
  useEffect(() => {
    if (!configured) return;
    void currentBackendUser().then((next) => { setUser(next); onUserChange(next); })
      .catch(() => setNotice('无法读取登录状态，请稍后重试。'));
  }, [configured, onUserChange]);

  if (!configured)
    return <span className="production-access production-access--setup"><ShieldCheck size={14} /> 公开展示模式</span>;
  if (user)
    return <div className="production-access"><span title={user.email}><ShieldCheck size={14} /> {user.email}</span>
      <button type="button" className="access-button" onClick={() => { signOutBackend(); setUser(null); onUserChange(null); }}><LogOut size={14} /> 退出</button>
    </div>;
  return <div className="production-access">
    <button type="button" className="access-button" disabled={busy} onClick={() => {
      setBusy(true); setNotice('');
      void loginWithAccess().then((next) => { setUser(next); onUserChange(next); })
        .catch((error) => setNotice(error instanceof Error ? error.message : '登录失败。')).finally(() => setBusy(false));
    }}><LogIn size={14} /> {busy ? '等待邮箱验证…' : '邮箱登录'}</button>
    <small className="access-notice"><Mail size={12} /> 仅管理员在 Cloudflare Access 中允许的邮箱可进入。</small>
    {notice && <small className="access-notice">{notice}</small>}
  </div>;
}
