import { useEffect, useState, type FormEvent } from 'react';
import { ApiError, api } from '../api';
import { Shell } from '../components/Shell';
import type { Installation, Role, User } from '../types';

type AuditItem = { auditId: string; createdAt: string; action: string; actorId: string; resourceType: string; resourceId: string };

export function AdminPage() {
  const [installations, setInstallations] = useState<Installation[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [audits, setAudits] = useState<AuditItem[]>([]);
  const [apiKey, setApiKey] = useState('');
  const [error, setError] = useState('');
  const [name, setName] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const [userName, setUserName] = useState('');
  const [userEmail, setUserEmail] = useState('');
  const [userPassword, setUserPassword] = useState('');
  const [userRole, setUserRole] = useState<Role>('reviewer');

  async function reload() {
    const [installationResult, userResult, auditResult] = await Promise.all([
      api<{ items: Installation[] }>('/api/v1/installations'),
      api<{ items: User[] }>('/api/v1/users'),
      api<{ items: AuditItem[] }>('/api/v1/audit?limit=30'),
    ]);
    setInstallations(installationResult.items);
    setUsers(userResult.items);
    setAudits(auditResult.items);
  }

  useEffect(() => {
    reload().catch((err: Error) => setError(err.message));
  }, []);

  async function createInstallation(event: FormEvent) {
    event.preventDefault();
    setError('');
    try {
      const result = await api<{ apiKey: string }>('/api/v1/installations', {
        method: 'POST',
        body: JSON.stringify({ name, contactEmail: contactEmail || undefined }),
      });
      setApiKey(result.apiKey);
      setName('');
      setContactEmail('');
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create installation');
    }
  }

  async function createUser(event: FormEvent) {
    event.preventDefault();
    setError('');
    try {
      await api('/api/v1/users', {
        method: 'POST',
        body: JSON.stringify({ name: userName, email: userEmail, password: userPassword, role: userRole }),
      });
      setUserName('');
      setUserEmail('');
      setUserPassword('');
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create user');
    }
  }

  async function disable(installationId: string) {
    await api(`/api/v1/installations/${installationId}/disable`, { method: 'POST' });
    await reload();
  }

  return (
    <Shell>
      <main className="page">
        <p className="eyebrow">Administration</p>
        <h1>Installations, reviewers, and audit</h1>
        {error ? <p className="form-error">{error}</p> : null}
        {apiKey ? (
          <p className="banner warn">
            New API key, shown once: <code>{apiKey}</code>
            <button type="button" className="secondary" onClick={() => void navigator.clipboard.writeText(apiKey)}>Copy</button>
          </p>
        ) : null}
        <div className="admin-grid">
          <section>
            <h2>New installation</h2>
            <form className="stack" onSubmit={(event) => void createInstallation(event)}>
              <label>Name<input value={name} onChange={(event) => setName(event.target.value)} required /></label>
              <label>Contact email<input value={contactEmail} onChange={(event) => setContactEmail(event.target.value)} type="email" /></label>
              <button className="primary" type="submit">Create installation</button>
            </form>
            <ul className="plain-list">
              {installations.map((installation) => (
                <li key={installation.installationId}>
                  <strong>{installation.name}</strong>
                  <span>{installation.status}</span>
                  {installation.status === 'active' ? (
                    <button type="button" className="ghost" onClick={() => void disable(installation.installationId)}>Disable</button>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
          <section>
            <h2>New reviewer or admin</h2>
            <form className="stack" onSubmit={(event) => void createUser(event)}>
              <label>Name<input value={userName} onChange={(event) => setUserName(event.target.value)} required /></label>
              <label>Email<input value={userEmail} onChange={(event) => setUserEmail(event.target.value)} type="email" required /></label>
              <label>Password<input value={userPassword} onChange={(event) => setUserPassword(event.target.value)} type="password" minLength={12} required /></label>
              <label>
                Role
                <select value={userRole} onChange={(event) => setUserRole(event.target.value as Role)}>
                  <option value="reviewer">Reviewer</option>
                  <option value="administrator">Administrator</option>
                </select>
              </label>
              <button className="primary" type="submit">Create user</button>
            </form>
            <ul className="plain-list">
              {users.map((user) => (
                <li key={user.userId}><strong>{user.name}</strong><span>{user.email}</span><span>{user.role}</span></li>
              ))}
            </ul>
          </section>
        </div>
        <section>
          <h2>Recent audit</h2>
          <ul className="plain-list">
            {audits.map((item) => (
              <li key={item.auditId}>
                <code>{item.action}</code>
                <span>{item.resourceType} {item.resourceId.slice(0, 8)}</span>
                <span>{new Date(item.createdAt).toLocaleString()}</span>
              </li>
            ))}
          </ul>
        </section>
      </main>
    </Shell>
  );
}
