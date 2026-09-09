import { useEffect, useState } from 'react';
import { LogIn, LogOut, Mail, ShieldCheck } from 'lucide-react';
import type { MorphUser } from './morphBackend';
import { backendConfig, currentBackendUser, loadBackendConfig, loginWithAccess, signOutBackend } from './morphBackend';

type Props = { onUserChange: (user: MorphUser | null) => void };

/** Supabase email sign-in links. Accounts are invited by an administrator; public sign-up is disabled. */
export function ProductionAccess({ onUserChange }: Props) {
  const [configured, setConfigured] = useState(Boolean(backendConfig()));
  const [user, setUser] = useState<MorphUser | null>(null);
  const [email, setEmail] = useState('');
  const [linkSent, setLinkSent] = useState(false);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => { void loadBackendConfig().then((config) => setConfigured(Boolean(config))); }, []);
  useEffect(() => {
    if (!configured) return;
    void currentBackendUser().then((next) => { setUser(next); onUserChange(next); })
      .catch(() => setNotice('生产工作区还未完成初始化。'));
  }, [configured, onUserChange]);

  if (!configured)
    return <span className="production-access production-access--setup"><ShieldCheck size={14} /> 公开展示模式</span>;
  if (user)
    return <div className="production-access"><span title={user.email}><ShieldCheck size={14} /> {user.email}</span>
      <button type="button" className="access-button" onClick={() => {
        void signOutBackend().finally(() => { setUser(null); onUserChange(null); });
      }}><LogOut size={14} /> 退出</button>
    </div>;
  return <div className="production-access production-access--login">
    {!linkSent ? <>
      <input aria-label="工作邮箱" type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="工作邮箱" />
      <button type="button" className="access-button" disabled={busy} onClick={() => {
        setBusy(true); setNotice('');
        void loginWithAccess(email).then(() => { setLinkSent(true); setNotice('登录链接已发送至邮箱。'); })
          .catch((error) => setNotice(error instanceof Error ? error.message : '发送登录链接失败。')).finally(() => setBusy(false));
      }}><LogIn size={14} /> {busy ? '发送中…' : '发送登录链接'}</button>
    </> : <>
      <span className="access-link-sent"><ShieldCheck size={14} /> 请点击邮件中的登录链接</span>
      <button type="button" className="access-button access-button--quiet" onClick={() => { setLinkSent(false); }}>更换邮箱</button>
    </>}
    <small className="access-notice"><Mail size={12} /> 仅受邀成员可通过邮箱登录链接进入。</small>
    {notice && <small className="access-notice">{notice}</small>}
  </div>;
}
