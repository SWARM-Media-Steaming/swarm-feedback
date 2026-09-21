import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ApiError, api } from '../api';
import { Shell, statusLabel } from '../components/Shell';
import { SCORE_FIELDS, type ExecutionDetail, type QueueItem, type ReviewDraft, type ScoreKey } from '../types';

type FormState = {
  scores: Partial<Record<ScoreKey, number>>;
  whatWasDoneWell: string;
  missingInformation: string;
  ambiguous: string;
  couldBeWrittenBetter: string;
  recommendedImprovedPrompt: string;
  generalComments: string;
};

const emptyForm = (): FormState => ({
  scores: {},
  whatWasDoneWell: '',
  missingInformation: '',
  ambiguous: '',
  couldBeWrittenBetter: '',
  recommendedImprovedPrompt: '',
  generalComments: '',
});

export function ReviewPage() {
  const { executionId = '' } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [execution, setExecution] = useState<ExecutionDetail | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    const query = new URLSearchParams(params);
    query.set('limit', '50');
    api<{ items: QueueItem[] }>(`/api/v1/review-queue?${query.toString()}`)
      .then((result) => setQueue(result.items))
      .catch(() => setQueue([]));
  }, [params, executionId]);

  useEffect(() => {
    setMessage('');
    setError('');
    setDirty(false);
    api<{ execution: ExecutionDetail; review: ReviewDraft | null }>(`/api/v1/executions/${executionId}`)
      .then((result) => {
        setExecution(result.execution);
        setForm(result.review ? {
          scores: result.review.scores ?? {},
          whatWasDoneWell: result.review.whatWasDoneWell,
          missingInformation: result.review.missingInformation,
          ambiguous: result.review.ambiguous,
          couldBeWrittenBetter: result.review.couldBeWrittenBetter,
          recommendedImprovedPrompt: result.review.recommendedImprovedPrompt,
          generalComments: result.review.generalComments,
        } : emptyForm());
      })
      .catch((err: Error) => setError(err.message));
  }, [executionId]);

  const index = queue.findIndex((item) => item.executionId === executionId);
  const previous = index > 0 ? queue[index - 1] : null;
  const next = index >= 0 && index < queue.length - 1 ? queue[index + 1] : null;
  const missingScores = useMemo(() => SCORE_FIELDS.filter(([key]) => !form.scores[key]).map(([, label]) => label), [form.scores]);

  function edit(patch: Partial<FormState>) {
    setForm((current) => ({ ...current, ...patch }));
    setDirty(true);
  }

  function setScore(key: ScoreKey, value: number) {
    setForm((current) => ({ ...current, scores: { ...current.scores, [key]: value } }));
    setDirty(true);
  }

  function go(target: QueueItem | null) {
    if (!target) return;
    if (dirty && !window.confirm('Leave without saving this draft?')) return;
    navigate(`/reviews/${target.executionId}?${params.toString()}`);
  }

  async function copyPrompt() {
    if (!execution) return;
    try {
      await navigator.clipboard.writeText(execution.prompt.effectivePrompt);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setError('Clipboard access was blocked. Select the prompt text above and copy it.');
    }
  }

  async function run(action: 'draft' | 'submit' | 'needs') {
    setPending(true);
    setError('');
    setMessage('');
    try {
      if (action === 'draft') {
        await api(`/api/v1/executions/${executionId}/review`, { method: 'PUT', body: JSON.stringify(form) });
        setMessage('Draft saved.');
      } else if (action === 'needs') {
        await api(`/api/v1/executions/${executionId}/review/needs-information`, {
          method: 'POST',
          body: JSON.stringify({ missingInformation: form.missingInformation, generalComments: form.generalComments }),
        });
        setMessage('Marked as needing more information. It stays out of customer feedback until you submit a review.');
        if (execution) setExecution({ ...execution, reviewStatus: 'needs_more_information' });
      } else {
        await api(`/api/v1/executions/${executionId}/review/submit`, { method: 'POST', body: JSON.stringify(form) });
        setMessage('Review submitted. The installation can retrieve this feedback.');
        if (execution) setExecution({ ...execution, reviewStatus: 'completed' });
      }
      setDirty(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Request failed');
    } finally {
      setPending(false);
    }
  }

  return (
    <Shell>
      <div className="workspace">
        <aside className="rail">
          <Link className="back" to={`/queue?${params.toString()}`}>Back to queue</Link>
          {queue.map((item) => (
            <button
              key={item.executionId}
              type="button"
              className={item.executionId === executionId ? 'rail-item active' : 'rail-item'}
              onClick={() => go(item)}
            >
              <strong>{item.issueTitle}</strong>
              <span>{item.repositoryKey}</span>
            </button>
          ))}
        </aside>
        <main className="review">
          {!execution ? <p className="empty">{error || 'Loading execution…'}</p> : (
            <>
              <div className="review-head">
                <div>
                  <p className="eyebrow">{execution.repository.key} · {execution.installationName}</p>
                  <h1>{execution.githubIssue.title}</h1>
                  <p className="meta-line">
                    <span className={`pill status-${execution.reviewStatus}`}>{statusLabel(execution.reviewStatus)}</span>
                    <span>{execution.ai.provider} / {execution.ai.model}</span>
                    <span>Outcome {execution.outcome.status}</span>
                    {execution.githubIssue.number ? <span>Issue #{execution.githubIssue.number}</span> : null}
                  </p>
                </div>
                <div className="pager">
                  <button type="button" className="secondary" disabled={!previous} onClick={() => go(previous)}>Previous</button>
                  <button type="button" className="secondary" disabled={!next} onClick={() => go(next)}>Next</button>
                </div>
              </div>
              {execution.secretFindings.length > 0 ? (
                <p className="banner warn">Potential secrets were redacted before this execution was stored.</p>
              ) : null}
              {execution.supplementalUpdatedAt ? (
                <p className="banner">The installation added information at {new Date(execution.supplementalUpdatedAt).toLocaleString()}.</p>
              ) : null}
              <section className="panes">
                <article>
                  <h2>Issue</h2>
                  {execution.githubIssue.url ? <a href={execution.githubIssue.url} target="_blank" rel="noreferrer">{execution.githubIssue.url}</a> : null}
                  <p className="labels">{execution.githubIssue.labels.join(' · ') || 'No labels'}</p>
                  <pre>{execution.githubIssue.body || 'No issue body was submitted.'}</pre>
                </article>
                <article className="prompt-pane">
                  <div className="pane-title">
                    <h2>Prompt</h2>
                    <button type="button" className="secondary" onClick={() => void copyPrompt()}>{copied ? 'Copied' : 'Copy prompt'}</button>
                  </div>
                  {execution.prompt.promptId ? <p className="labels">Prompt id {execution.prompt.promptId}</p> : null}
                  <pre className="prompt-text">{execution.prompt.effectivePrompt}</pre>
                  {execution.prompt.systemPrompt ? (
                    <details>
                      <summary>System prompt</summary>
                      <pre>{execution.prompt.systemPrompt}</pre>
                    </details>
                  ) : null}
                </article>
                <article>
                  <h2>Result</h2>
                  <p><strong>Request summary.</strong> {execution.ai.requestSummary || 'None'}</p>
                  <p><strong>Change summary.</strong> {execution.ai.changeSummary || 'None'}</p>
                  <p><strong>Outcome.</strong> {execution.outcome.summary || execution.outcome.status}</p>
                  {execution.codeChange.pullRequest ? (
                    <p>
                      <strong>Pull request.</strong>{' '}
                      {execution.codeChange.pullRequest.url ? (
                        <a href={execution.codeChange.pullRequest.url} target="_blank" rel="noreferrer">
                          {execution.codeChange.pullRequest.title || `#${execution.codeChange.pullRequest.number ?? ''}`}
                        </a>
                      ) : execution.codeChange.pullRequest.title}
                    </p>
                  ) : null}
                  <h3>Files</h3>
                  {execution.codeChange.filesChanged.length === 0 ? <p className="labels">No files reported.</p> : (
                    <ul className="file-list">
                      {execution.codeChange.filesChanged.map((file) => (
                        <li key={file.path}><code>{file.path}</code> <em>{file.changeType}</em></li>
                      ))}
                    </ul>
                  )}
                  {execution.codeChange.commits.length > 0 ? (
                    <>
                      <h3>Commits</h3>
                      <ul className="file-list">
                        {execution.codeChange.commits.map((commit) => (
                          <li key={commit.sha}><code>{commit.sha.slice(0, 8)}</code> {commit.message}</li>
                        ))}
                      </ul>
                    </>
                  ) : null}
                  <h3>Operational notes</h3>
                  <pre>{execution.operationalNotes || 'None'}</pre>
                  <h3>Errors and warnings</h3>
                  {[...execution.errors, ...execution.warnings].length === 0 ? <p className="labels">None</p> : (
                    <ul className="file-list">
                      {execution.errors.map((item, index) => <li key={`e${index}`}>{item.message}</li>)}
                      {execution.warnings.map((item, index) => <li key={`w${index}`}>{item.message}</li>)}
                    </ul>
                  )}
                </article>
              </section>
              <section className="grading">
                <h2>Scores</h2>
                <div className="score-grid">
                  {SCORE_FIELDS.map(([key, label, help]) => (
                    <fieldset key={key}>
                      <legend>{label}</legend>
                      <p>{help}</p>
                      <div className="score-buttons">
                        {[1, 2, 3, 4, 5].map((value) => (
                          <button
                            key={value}
                            type="button"
                            aria-pressed={form.scores[key] === value}
                            className={form.scores[key] === value ? 'score on' : 'score'}
                            onClick={() => setScore(key, value)}
                          >
                            {value}
                          </button>
                        ))}
                      </div>
                    </fieldset>
                  ))}
                </div>
                <div className="notes-grid">
                  <label>What was done well<textarea value={form.whatWasDoneWell} onChange={(event) => edit({ whatWasDoneWell: event.target.value })} /></label>
                  <label>What information was missing<textarea value={form.missingInformation} onChange={(event) => edit({ missingInformation: event.target.value })} /></label>
                  <label>What was ambiguous<textarea value={form.ambiguous} onChange={(event) => edit({ ambiguous: event.target.value })} /></label>
                  <label>What could have been written better<textarea value={form.couldBeWrittenBetter} onChange={(event) => edit({ couldBeWrittenBetter: event.target.value })} /></label>
                  <label className="wide">General comments<textarea value={form.generalComments} onChange={(event) => edit({ generalComments: event.target.value })} /></label>
                  <label className="wide">
                    Recommended improved prompt
                    <span className="field-note">This is returned to the SWARM Automation owner as the prompt to use next time.</span>
                    <textarea className="prompt-editor" value={form.recommendedImprovedPrompt} onChange={(event) => edit({ recommendedImprovedPrompt: event.target.value })} />
                  </label>
                </div>
                {missingScores.length > 0 ? <p className="labels">Submit needs scores for: {missingScores.join(', ')}.</p> : null}
                {error ? <p className="form-error">{error}</p> : null}
                {message ? <p className="banner good">{message}</p> : null}
                <div className="actions">
                  <button type="button" className="secondary" disabled={pending} onClick={() => void run('draft')}>Save draft</button>
                  <button type="button" className="secondary" disabled={pending || !form.missingInformation.trim()} onClick={() => void run('needs')}>Needs more information</button>
                  <button type="button" className="primary" disabled={pending || missingScores.length > 0} onClick={() => void run('submit')}>Submit review</button>
                </div>
              </section>
            </>
          )}
        </main>
      </div>
    </Shell>
  );
}
