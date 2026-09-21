import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { Shell, statusLabel } from '../components/Shell';
import type { Installation, QueueItem, ReviewStatus } from '../types';

const STATUSES: Array<ReviewStatus | 'all'> = ['pending', 'in_review', 'needs_more_information', 'completed', 'all'];

export function QueuePage() {
  const [params, setParams] = useSearchParams();
  const [items, setItems] = useState<QueueItem[]>([]);
  const [installations, setInstallations] = useState<Installation[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const status = params.get('status') ?? 'pending';
  const installationId = params.get('installationId') ?? '';
  const repository = params.get('repository') ?? '';
  const q = params.get('q') ?? '';

  useEffect(() => {
    api<{ items: Installation[] }>('/api/v1/installations').then((result) => setInstallations(result.items)).catch(() => setInstallations([]));
  }, []);

  useEffect(() => {
    const query = new URLSearchParams();
    if (status) query.set('status', status);
    if (installationId) query.set('installationId', installationId);
    if (repository) query.set('repository', repository);
    if (q) query.set('q', q);
    query.set('limit', '50');
    setLoading(true);
    api<{ items: QueueItem[] }>(`/api/v1/review-queue?${query.toString()}`)
      .then((result) => {
        setItems(result.items);
        setError('');
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  }, [status, installationId, repository, q]);

  function update(next: Record<string, string>) {
    const merged = new URLSearchParams(params);
    for (const [key, value] of Object.entries(next)) {
      if (value) merged.set(key, value);
      else merged.delete(key);
    }
    setParams(merged);
  }

  return (
    <Shell>
      <main className="page">
        <div className="page-head">
          <div>
            <p className="eyebrow">Review queue</p>
            <h1>Executions waiting on a person</h1>
          </div>
          <p className="count">{loading ? '…' : `${items.length} shown`}</p>
        </div>
        <form className="filters" onSubmit={(event) => event.preventDefault()}>
          <label>
            Status
            <select value={status} onChange={(event) => update({ status: event.target.value })}>
              {STATUSES.map((value) => <option key={value} value={value}>{statusLabel(value)}</option>)}
            </select>
          </label>
          <label>
            Installation
            <select value={installationId} onChange={(event) => update({ installationId: event.target.value })}>
              <option value="">All installations</option>
              {installations.map((installation) => (
                <option key={installation.installationId} value={installation.installationId}>{installation.name}</option>
              ))}
            </select>
          </label>
          <label>
            Repository
            <input value={repository} placeholder="owner/name" onChange={(event) => update({ repository: event.target.value })} />
          </label>
          <label>
            Search
            <input value={q} placeholder="Issue, model, id" onChange={(event) => update({ q: event.target.value })} />
          </label>
        </form>
        {error ? <p className="form-error">{error}</p> : null}
        <div className="queue-table">
          {items.length === 0 && !loading ? <p className="empty">Nothing in this slice of the queue.</p> : null}
          {items.map((item) => (
            <Link key={item.executionId} className="queue-row" to={`/reviews/${item.executionId}?${params.toString()}`}>
              <div>
                <strong>{item.issueTitle}</strong>
                <span>{item.repositoryKey} · {item.installationName}</span>
              </div>
              <div className="queue-meta">
                <span className={`pill status-${item.reviewStatus}`}>{statusLabel(item.reviewStatus)}</span>
                <span>{item.provider}/{item.model}</span>
                <span>{item.outcomeStatus}</span>
                {item.secretFindingCount > 0 ? <span className="pill warn">secrets redacted</span> : null}
              </div>
            </Link>
          ))}
        </div>
      </main>
    </Shell>
  );
}
