# SWARM Feedback

SWARM Feedback is a review service for prompts that SWARM Automation installations send to coding agents. An installation uploads a completed execution. A human reviewer grades the prompt and the resulting change. The installation later pulls that feedback, including a recommended replacement prompt.

The service is a TypeScript monorepo:

- `server` — versioned HTTP API, review workflow, authentication, and DynamoDB persistence
- `web` — desktop-focused reviewer UI
- DynamoDB — source of truth, with DynamoDB Local or Docker for development

Customer data is scoped to the installation that uploaded it. Reviewers and administrators are staff accounts and can see the review queue across installations.

## Local development

```bash
cp .env.example .env
npm install
sh scripts/download-dynamodb.sh
npm run dev
```

`npm run dev` starts the API on `http://localhost:8787` and the reviewer UI on `http://localhost:5173`. The UI proxies `/api` to the API.

Seeded development accounts (change these before any shared deployment):

- Administrator: `admin@localhost` / `local-admin-pass-1`
- Reviewer: `reviewer@localhost` / `local-reviewer-pass-1`

Create an installation from the Admin page. The API key is shown once. Installations call the API with `Authorization: Bearer sf_...`. Do not upload GitHub or model-provider credentials. The schema rejects credential field names, and recognizable secrets in text are redacted before storage.

Docker is an alternative to the Java process:

```bash
npm run dynamodb:up
```

If port 8000 is already open, the integration script reuses it.

## Verification

```bash
npm test
npm run test:integration
npm run typecheck
npm run build
```

`npm test` exercises validation, redaction, authorization, idempotent uploads, and the review feedback loop against in-memory repositories. `npm run test:integration` starts DynamoDB Local when needed and checks table creation, encryption, and indexed queries.

## API

All routes live under `/api/v1`. The contract is in [docs/openapi.yaml](docs/openapi.yaml).

| Purpose | Method and path |
| --- | --- |
| Health | `GET /api/v1/health`, `GET /api/v1/ready` |
| Staff sign-in | `POST /api/v1/auth/login`, `GET /api/v1/auth/me` |
| Register an installation | `POST /api/v1/installations` or `POST /api/v1/installations/register` |
| Upload one execution | `POST /api/v1/executions` |
| Upload a batch of up to 20 | `POST /api/v1/executions/batch` |
| Upload status | `GET /api/v1/executions/{executionId}/status` |
| Add information after upload | `PATCH /api/v1/executions/{executionId}` |
| Review queue | `GET /api/v1/review-queue` |
| Save, submit, or request information | `/api/v1/executions/{executionId}/review...` |
| Read completed feedback | `GET /api/v1/feedback` |
| Acknowledge a feedback version | `POST /api/v1/feedback/{reviewId}/acknowledgements` |

Uploads are idempotent on the client-supplied `executionId`. The same payload returns the original record. A different payload for that id returns `409`. Retries must reuse the id.

Processing is synchronous in this version: a stored execution is immediately `ready_for_review`. The status field can later represent a queue without an API change.

### Execution upload

The body is JSON. Required pieces are the GitHub issue, the final effective prompt, provider and model, repository, code-change metadata, and an outcome of `success`, `partial`, `failed`, or `cancelled`. Operational notes, errors, warnings, pull requests, and commits are optional. Request bodies are limited to 1.5 MB.

### Feedback

Completed reviews are visible to the originating installation. Each item includes the execution id, review id, nine scores, the overall score (overall prompt quality), the score average, comments, deficiencies, recommendations, the recommended improved prompt, the reviewer timestamp, the review version, delivery status, and `evaluatorType`.

Acknowledge a specific `reviewVersion`. Acknowledging the current version twice is safe. Acknowledging an older version returns `409` with the current version. A newer human submission sets delivery back to `available`.

`evaluatorType` is `human` or `automated`. Automated evaluations are separate review rows, so they can be added later without changing execution identity or the feedback payload.

## Review workflow

Queue statuses are `pending`, `in_review`, `completed`, and `needs_more_information`. Reviewers claim an execution, score it from 1 to 5, and either save a draft, ask for more information, or submit. Needs-more-information is not delivered as customer feedback. When the installation patches the execution, that item returns to `pending`.

Scores:

- Prompt clarity
- Prompt completeness
- Context quality
- Technical specificity
- Constraint quality
- Likelihood the model understood the intent
- Implementation quality
- Efficiency
- Overall prompt quality

The recommended improved prompt is stored on the review and returned verbatim (after secret redaction) to the installation.

## Security

- Staff sessions are HMAC-SHA256 JWTs. Installation API keys are random `sf_` bearer tokens stored as SHA-256 hashes.
- Roles are administrator, reviewer, and customer/installation. A customer can only read and update its own executions and feedback.
- Prompts, issue bodies, operational notes, the raw payload, update history, and recommended prompts are encrypted with AES-256-GCM before they are written. Set `DATA_ENCRYPTION_KEY_HEX` from a secret manager in production. Losing the key makes stored text unreadable.
- In AWS, also enable DynamoDB encryption at rest with a KMS key. Terminate TLS at the load balancer and set `TRUST_PROXY=true` only behind that proxy.
- Requests are validated with Zod, size-limited, and rate-limited per token.
- Uploads are scanned for common tokens (GitHub, AWS, private keys, Slack, OpenAI, and similar). Findings are stored as type and field path, never as the secret.
- Mutations are written to the audit table. Audit records do not include prompts or credentials.
- Production startup refuses the development JWT secret, encryption key, bootstrap token, seeded users, and a localhost DynamoDB endpoint.

Do not point production at DynamoDB Local. Leave `DYNAMODB_ENDPOINT` unset so the AWS SDK uses the task role and the regional DynamoDB endpoint.

## Deployment shape

Build the container from the repository root. It serves the API and the built reviewer UI when `SERVE_WEB=true`.

```bash
npm run build
npm start
```

On boot the process creates any missing DynamoDB tables (on-demand billing) and records migration `001_init`. Table names use `DYNAMODB_TABLE_PREFIX`. Give the task role read/write access only to those tables. Put `JWT_SECRET`, `DATA_ENCRYPTION_KEY_HEX`, and `BOOTSTRAP_TOKEN` in a secret manager. Keep `SEED_DEMO=false`.

Tables: installations, users, executions, reviews, audit, and migrations. Executions keep the original encrypted payload plus queryable columns for status, installation, repository, model, and issue title.
