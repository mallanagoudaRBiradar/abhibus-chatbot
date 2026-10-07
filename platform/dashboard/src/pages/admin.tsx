import { useState } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useData } from '../lib/live';
import { href } from '../lib/router';
import { ago } from '../lib/format';
import { Btn, Chip, ErrorBox, Field, Head, Loading, Modal, Panel, SecretOnce, Seg, Switch, useAction } from '../components/ui';

const PERM_LABEL: Record<string, string> = {
  'rooms.read': 'See rooms', 'rooms.act': 'Alerts & trip tools', 'inbox.act': 'Work the inbox', 'broadcast.send': 'Bulk broadcast', 'members.reveal': 'Reveal bookings',
  'moderation.act': 'Moderate', 'audit.read': 'Audit log', 'campaigns.read': 'See campaigns', 'campaigns.write': 'Run campaigns', 'config.read': 'See config', 'config.write': 'Edit config',
  'keys.manage': 'API keys', 'webhooks.manage': 'Webhooks', 'sandbox.use': 'Sandbox', 'users.manage': 'Users & roles', 'tenants.manage': 'Tenants', 'events.read': 'Event stream',
};

export function AdminUsers() {
  const { user: me, tenants } = useAuth();
  const d = useData<{ data: any[]; roles: { id: string; label: string; permissions: string[] }[] }>('/users');
  const [inviting, setInviting] = useState(false);
  const [temp, setTemp] = useState<{ email: string; pw: string } | null>(null);
  const [editing, setEditing] = useState<any>(null);
  const { busy, run } = useAction();
  if (d.error) return <section className="cmain"><ErrorBox msg={d.error} /></section>;
  if (!d.data) return <section className="cmain"><Loading /></section>;
  const roles = d.data.roles;
  const patch = (u: any, body: any, ok: string) => run(u.id + Object.keys(body)[0], () => api<any>(`/users/${u.id}`, { method: 'PATCH', body }), ok).then((r) => { if (r?.temporary_password) setTemp({ email: u.email, pw: r.temporary_password }); d.reload(); });
  return (
    <section className="cmain">
      <Head title="Users & roles" sub="Who can sign in to this console and what they can do. App access limits a person to specific apps (e.g. AbhiBus Ops sees only AbhiBus rooms)." right={<Btn kind="pri" onClick={() => setInviting(true)}>Add person</Btn>} />
      <div className="tw"><table>
        <thead><tr><th>Person</th><th>Role</th><th>Apps</th><th>Last sign-in</th><th>Active</th><th /></tr></thead>
        <tbody>{d.data.data.map((u) => (
          <tr key={u.id} style={!u.active ? { opacity: 0.55 } : undefined}>
            <td><b>{u.name}</b>{u.id === me!.id && <> <Chip tone="c-info">you</Chip></>}<small>{u.email}</small></td>
            <td><select className="tsel" value={u.role} disabled={u.id === me!.id} onChange={(e) => patch(u, { role: e.target.value }, 'Role updated')}>{roles.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}</select></td>
            <td>{u.tenants.length ? u.tenants.map((t: string) => <Chip key={t}>{tenants.find((x) => x.id === t)?.name ?? t}</Chip>) : <Chip tone="c-ok">all apps</Chip>} <Btn sm kind="ghost" onClick={() => setEditing(u)}>Edit</Btn></td>
            <td className="num">{u.last_login_at ? ago(u.last_login_at) : 'never'}</td>
            <td><Switch on={u.active} label="Active" disabled={u.id === me!.id} onChange={(v) => patch(u, { active: v }, v ? 'Activated' : 'Deactivated')} /></td>
            <td><Btn sm kind="ghost" busy={busy === `${u.id}reset_password`} onClick={() => confirm(`Reset ${u.name}’s password?`) && patch(u, { reset_password: true }, 'Password reset')}>Reset password</Btn></td>
          </tr>
        ))}</tbody>
      </table></div>
      <Panel title="What each role can do">
        <div className="tw"><table>
          <thead><tr><th>Role</th><th>Permissions</th></tr></thead>
          <tbody>{roles.map((r) => (
            <tr key={r.id}><td><b>{r.label}</b></td><td><div className="perm-grid">{Object.keys(PERM_LABEL).map((p) => <span key={p} className={r.permissions.includes(p) ? 'on' : ''}>{r.permissions.includes(p) ? '✓' : '·'} {PERM_LABEL[p]}</span>)}</div></td></tr>
          ))}</tbody>
        </table></div>
      </Panel>
      {inviting && <Invite roles={roles} onClose={() => setInviting(false)} onDone={(email, pw) => { setInviting(false); setTemp({ email, pw }); d.reload(); }} />}
      {editing && <AppsModal u={editing} onClose={() => setEditing(null)} onSave={(t) => patch(editing, { tenants: t }, 'App access updated').then(() => setEditing(null))} />}
      {temp && <Modal title="Temporary password" onClose={() => setTemp(null)}><div className="f" style={{ gap: 10 }}><p className="prose">Share this with <b>{temp.email}</b> over a secure channel. Ask them to change it after signing in (top-right menu → Change password).</p><SecretOnce label="Temporary password" value={temp.pw} note="Shown once." /></div></Modal>}
    </section>
  );
}

function AppPicker({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const { tenants } = useAuth();
  const all = !value.length;
  return (
    <div className="f" style={{ gap: 6 }}>
      <Seg value={all ? 'all' : 'some'} onChange={(v) => onChange(v === 'all' ? [] : [tenants[0]?.id].filter(Boolean) as string[])} options={[['all', 'All apps'], ['some', 'Only some apps']]} />
      {!all && <div className="checks">{tenants.map((t) => <label key={t.id}><input type="checkbox" checked={value.includes(t.id)} onChange={() => onChange(value.includes(t.id) ? value.filter((x) => x !== t.id) : [...value, t.id])} /> {t.name}</label>)}</div>}
    </div>
  );
}
function AppsModal({ u, onClose, onSave }: { u: any; onClose: () => void; onSave: (t: string[]) => void }) {
  const [t, setT] = useState<string[]>(u.tenants);
  return <Modal title={`App access · ${u.name}`} onClose={onClose}><div className="f" style={{ gap: 12 }}><AppPicker value={t} onChange={setT} /><div><Btn kind="pri" onClick={() => onSave(t)}>Save</Btn></div></div></Modal>;
}
function Invite({ roles, onClose, onDone }: { roles: { id: string; label: string }[]; onClose: () => void; onDone: (email: string, pw: string) => void }) {
  const [name, setName] = useState(''); const [email, setEmail] = useState(''); const [role, setRole] = useState('ops'); const [t, setT] = useState<string[]>([]);
  const { busy, run } = useAction();
  return (
    <Modal title="Add person" onClose={onClose}>
      <div className="f" style={{ gap: 10 }}>
        <Field label="Name"><input value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="Work email"><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
        <Field label="Role"><select value={role} onChange={(e) => setRole(e.target.value)}>{roles.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}</select></Field>
        <Field label="App access"><AppPicker value={t} onChange={setT} /></Field>
        <div><Btn kind="pri" busy={busy === 'i'} disabled={!name || !email} onClick={async () => { const r = await run('i', () => api<any>('/users', { body: { name, email, role, tenants: t } }), 'Person added'); if (r) onDone(r.user.email, r.temporary_password); }}>Add</Btn></div>
      </div>
    </Modal>
  );
}

export function AdminTenants() {
  const { tenants, refreshTenants, can } = useAuth();
  const [adding, setAdding] = useState(false);
  return (
    <section className="cmain">
      <Head title="Tenants" sub="Each app on the platform. Rooms, keys, webhooks, config and data are isolated per tenant." right={can('tenants.manage') && <Btn kind="pri" onClick={() => setAdding(true)}>Add tenant</Btn>} />
      <div className="tw"><table>
        <thead><tr><th>App</th><th>Tenant id</th><th>Modes</th><th>Brand</th><th>Config</th><th /></tr></thead>
        <tbody>{tenants.map((t) => (
          <tr key={t.id}><td><b>{t.name}</b>{t.quiet_now && <small>quiet hours now</small>}</td><td><code>{t.id}</code></td><td>{t.verticals.join(', ')}</td>
            <td><span className="swatch" style={{ background: t.theme.brand }} /> <code>{t.theme.brand}</code></td><td className="num">v{t.version}</td>
            <td><div className="fil"><a className="lnk" href={href(`/developer/config/${t.id}`)}>Config</a><a className="lnk" href={href('/developer/keys')}>Keys</a></div></td></tr>
        ))}</tbody>
      </table></div>
      <Panel title="Onboarding a new app">
        <div className="flow"><span className="s">Add tenant</span><span className="a">→</span><span className="s">Set brand, features, identity</span><span className="a">→</span><span className="s">Create API key</span><span className="a">→</span><span className="s">Add webhook endpoint</span><span className="a">→</span><span className="s">Sandbox → production</span></div>
      </Panel>
      {adding && <NewTenant onClose={() => setAdding(false)} onDone={() => { setAdding(false); void refreshTenants(); }} />}
    </section>
  );
}
function NewTenant({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [id, setId] = useState(''); const [name, setName] = useState(''); const [v, setV] = useState<string[]>(['bus']); const [brand, setBrand] = useState('#d4373c'); const [identity, setIdentity] = useState<'handle' | 'profile'>('handle');
  const { busy, run } = useAction();
  return (
    <Modal title="Add tenant" onClose={onClose}>
      <div className="f" style={{ gap: 10 }}>
        <div className="frow"><Field label="Name"><input value={name} onChange={(e) => { setName(e.target.value); if (!id) setId(''); }} placeholder="e.g. ixigo Buses" /></Field><Field label="Tenant id" hint="lowercase, used in API keys"><input value={id || name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')} onChange={(e) => setId(e.target.value)} /></Field></div>
        <Field label="Modes"><div className="checks">{['bus', 'train', 'flight', 'custom'].map((x) => <label key={x}><input type="checkbox" checked={v.includes(x)} onChange={() => setV((s) => s.includes(x) ? s.filter((y) => y !== x) : [...s, x])} /> {x}</label>)}</div></Field>
        <div className="frow"><Field label="Brand colour"><input type="color" value={brand} onChange={(e) => setBrand(e.target.value)} style={{ height: 38, padding: 2 }} /></Field><Field label="Identity"><select value={identity} onChange={(e) => setIdentity(e.target.value as any)}><option value="handle">Random handles</option><option value="profile">Profile names</option></select></Field></div>
        <div><Btn kind="pri" busy={busy === 't'} disabled={!name || !v.length} onClick={async () => { const r = await run('t', () => api('/tenants', { body: { id: id || name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''), name, verticals: v, theme: { brand, brandInk: '#ffffff', logoText: name }, identity } }), 'Tenant added'); if (r) onDone(); }}>Add tenant</Btn></div>
      </div>
    </Modal>
  );
}
