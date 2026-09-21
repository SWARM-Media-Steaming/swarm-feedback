import { NavLink } from 'react-router-dom';
import { useAuth } from '../auth';
import type { ReactNode } from 'react';

export function Shell({ children }: { children: ReactNode }) {
  const { user, logout } = useAuth();
  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">SF</span>
          <div>
            <strong>SWARM Feedback</strong>
            <small>Prompt review</small>
          </div>
        </div>
        <nav>
          <NavLink to="/queue">Queue</NavLink>
          {user?.role === 'administrator' ? <NavLink to="/admin">Admin</NavLink> : null}
        </nav>
        <div className="who">
          <span>{user?.name}</span>
          <em>{user?.role}</em>
          <button type="button" className="ghost" onClick={logout}>Sign out</button>
        </div>
      </header>
      {children}
    </div>
  );
}

export function statusLabel(status: string): string {
  return status.replaceAll('_', ' ');
}
