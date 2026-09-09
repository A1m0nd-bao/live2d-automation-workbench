import { useEffect, useState } from 'react';
import { GitBranch, LogOut, ShieldCheck } from 'lucide-react';
import type { MorphUser } from './morphBackend';
import { backendConfig, currentBackendUser, loadBackendConfig, loginWithGithub, signOutBackend } from './morphBackend';

type Props = { onUserChange: (user: MorphUser | null) => void };

/** GitHub OAuth. Supabase's access allowlist approves users before profiles are created. */
export function ProductionAccess({ onUserChange }: Props) {
  const [configured, setConfigured] = useState(Boolean(backendConfig()));
  const [user, setUser] = useState<MorphUser | null>(null);
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
    <button type="button" className="access-button" disabled={busy} onClick={() => {
      setBusy(true); setNotice('正在前往 GitHub 授权…');
      void loginWithGithub().catch((error) => {
        setNotice(error instanceof Error ? error.message : '无法开始 GitHub 登录。');
        setBusy(false);
      });
    }}><GitBranch size={14} /> {busy ? '正在跳转…' : '使用 GitHub 登录'}</button>
    <small className="access-notice"><ShieldCheck size={12} /> 仅管理员预先批准的 GitHub 邮箱可进入。</small>
    {notice && <small className="access-notice">{notice}</small>}
  </div>;
}
