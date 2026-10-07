import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, session } from './api';
import { connectLive, disconnectLive } from './live';

export interface User { id: string; email: string; name: string; role: string; role_label: string; tenants: string[]; permissions: string[]; last_login_at: string | null }
export interface Tenant { id: string; name: string; verticals: string[]; theme: { brand: string; brandInk: string; logoText?: string }; version: number; quiet_now: boolean }
interface Ctx {
  user: User | null; tenants: Tenant[]; ready: boolean;
  can: (p: string) => boolean; login: (email: string, password: string) => Promise<void>; logout: () => void;
  tenant: string; setTenant: (t: string) => void; tenantName: (id?: string | null) => string; refreshTenants: () => Promise<void>;
}
const AuthCtx = createContext<Ctx>(null as unknown as Ctx);
export const useAuth = () => useContext(AuthCtx);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [ready, setReady] = useState(false);
  const [tenant, setTenantState] = useState<string>(() => { try { return localStorage.getItem('tr.console.tenant') ?? ''; } catch { return ''; } });
  const setTenant = (t: string) => { setTenantState(t); try { localStorage.setItem('tr.console.tenant', t); } catch { /* */ } };

  const refreshTenants = async () => { const t = await api<{ data: Tenant[] }>('/tenants'); setTenants(t.data); if (tenant && !t.data.some((x) => x.id === tenant)) setTenant(''); };
  const boot = async () => {
    if (!session.token) { setReady(true); return; }
    try {
      const me = await api<{ user: User }>('/me');
      setUser(me.user);
      await refreshTenants().catch(() => setTenants([]));
      connectLive();
    } catch { clear(); }
    setReady(true);
  };
  /** Drop everything tied to the signed-in user so the next person starts clean. */
  const clear = () => {
    session.set(null); disconnectLive();
    setUser(null); setTenants([]); setTenant('');
    window.location.hash = '/';
  };
  useEffect(() => {
    void boot();
    const offUnauth = session.onUnauthorized(clear);
    const offChange = session.onChange((t) => { if (t) void boot(); else clear(); });
    return () => { offUnauth(); offChange(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const value: Ctx = {
    user, tenants, ready, tenant, setTenant, refreshTenants,
    can: (p) => !!user?.permissions.includes(p),
    tenantName: (id) => tenants.find((t) => t.id === id)?.name ?? id ?? 'Platform',
    login: async (email, password) => {
      const r = await api<{ token: string; user: User }>('/auth/login', { body: { email, password } });
      session.set(r.token); setUser(r.user);
      await refreshTenants().catch(() => setTenants([]));
      connectLive();
    },
    logout: () => {
      const t = session.token;
      clear();
      // Revoke server-side so the token is dead everywhere; sign out locally even if this fails.
      if (t) void api('/auth/logout', { method: 'POST', bearer: t }).catch(() => {});
    },
  };
  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>;
}
