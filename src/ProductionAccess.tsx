import { useEffect, useState } from 'react';
import { LogIn, LogOut, Mail, ShieldCheck } from 'lucide-react';
import type { Session } from '@supabase/supabase-js';
import {
  currentProductionSession,
  productionClient,
  productionConfig,
  sendProductionMagicLink,
  signOutProduction,
} from './supabaseProduction';

type Props = { onSessionChange: (session: Session | null) => void };

/** Real email auth surface; visitors can still view the public showcase. */
export function ProductionAccess({ onSessionChange }: Props) {
  const configured = Boolean(productionConfig());
  const [session, setSession] = useState<Session | null>(null);
  const [email, setEmail] = useState('');
  const [open, setOpen] = useState(false);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!configured) return;
    let alive = true;
    void currentProductionSession()
      .then((next) => {
        if (!alive) return;
        setSession(next);
        onSessionChange(next);
      })
      .catch(() => alive && setNotice('无法读取登录状态，请稍后重试。'));
    const subscription = productionClient()?.auth.onAuthStateChange((_event, next) => {
      setSession(next);
      onSessionChange(next);
    });
    return () => {
      alive = false;
      subscription?.data.subscription.unsubscribe();
    };
  }, [configured, onSessionChange]);

  if (!configured)
    return <span className="production-access production-access--setup"><ShieldCheck size={14} /> 公开展示模式</span>;

  if (session)
    return (
      <div className="production-access">
        <span title={session.user.email || ''}><ShieldCheck size={14} /> {session.user.email || '已登录'}</span>
        <button type="button" className="access-button" onClick={() => void signOutProduction().catch((error) => setNotice(error instanceof Error ? error.message : '退出失败。'))}>
          <LogOut size={14} /> 退出
        </button>
        {notice && <small>{notice}</small>}
      </div>
    );

  return (
    <div className="production-access">
      <button type="button" className="access-button" onClick={() => setOpen((value) => !value)}><LogIn size={14} /> 邮箱登录</button>
      {open && (
        <form className="access-popover" onSubmit={(event) => {
          event.preventDefault();
          if (!email.trim() || busy) return;
          setBusy(true); setNotice('');
          void sendProductionMagicLink(email)
            .then(() => setNotice('登录链接已发送，请在邮箱中打开。'))
            .catch((error) => setNotice(error instanceof Error ? error.message : '无法发送登录链接。'))
            .finally(() => setBusy(false));
        }}>
          <label><Mail size={14} /> 受邀邮箱
            <input required type="email" autoComplete="email" placeholder="name@company.com" value={email} onChange={(event) => setEmail(event.target.value)} />
          </label>
          <button className="primary-button" disabled={busy} type="submit">{busy ? '发送中…' : '发送登录链接'}</button>
          <small>仅限管理员邀请的账户。</small>
        </form>
      )}
      {notice && <small className="access-notice">{notice}</small>}
    </div>
  );
}
