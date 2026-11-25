# ServerlessQ: AWS Lambda Web Functions trivia sample

ServerlessQ is a multiplayer trivia sample built with Node.js 24, Express,
React, AWS Lambda Web Functions, Amazon DynamoDB, and Amazon Cognito. Players
join a game from a link or QR code, answer timed questions, and receive game
state and leaderboard updates through Server-Sent Events (SSE).

This is sample code for non-production usage. You should work with your
security and legal teams to meet your organizational security, regulatory, and
compliance requirements before deployment. Deploy it in a development AWS
account, use endpoint limits, and remove the resources when finished.

## Architecture

[![ServerlessQ architecture showing the browser, two Lambda Web Functions, Amazon
DynamoDB, Amazon Cognito, Amazon S3, and Amazon
CloudWatch](diagrams/serverlessq-architecture.png)](diagrams/serverlessq-architecture.png)

The diagram shows the default single-region data plane. Optional MultiRegion
endpoints can serve the same function revision from additional regions, while
the six DynamoDB tables remain in `primary_region`.

Two independently deployed Lambda Web Functions serve the application:

- `serverlessq-web` serves the built React application and `/config.json`.
- `serverlessq-api` serves public game routes, SSE streams, and authenticated
  administration routes.

Six DynamoDB tables hold question sets, questions, games, participants, answers,
and scores. A game snapshots its selected questions when created. One SSE
poller per game per execution environment reads shared state and broadcasts
updates to that environment's connected browsers. The browser reconnects
streams and falls back to polling after repeated failures. Public leaderboard
rows contain display names and scores, but not the player identifiers used by
the answer endpoint.

Cognito authenticates administrators with a public app client and authorizes
members of the `admins` group. Player routes remain anonymous. The frontend's
IAM role permits logging; the API role permits access to the application
tables and logging. A private, versioned S3 bucket stores deployment ZIPs.
CloudWatch receives application logs and metrics.

All persistent resources live in `primary_region`. Optional MultiRegion
endpoints run the same function revision in additional regions and access the
same regional DynamoDB tables. `replica_regions` selects additional function
regions; it does not create DynamoDB replicas.

Detailed diagrams cover:

- [Function revisions and endpoint traffic](diagrams/diagrams.md#function-revision-and-endpoint)
- [Runtime configuration and administrator authentication](diagrams/diagrams.md#runtime-configuration-and-authentication)
- [Shared SSE polling and browser reconnects](diagrams/diagrams.md#shared-sse-poller-and-reconnects)
- [Answer submission and round settlement](diagrams/diagrams.md#answers-and-round-settlement)

See the complete [architecture and request-flow
documentation](diagrams/diagrams.md), or download and edit the
[draw.io, PNG, and SVG architecture assets](diagrams/serverlessq-architecture.md).

## Prerequisites

- Node.js 24 and npm. `.nvmrc` selects the supported major version.
- Terraform 1.6 or later and the providers pinned in
  `infra/terraform/.terraform.lock.hcl`.
- AWS CLI with the `aws lambda-web` commands available, plus `jq`, Bash, and
  ZIP tooling. Verify availability with `aws lambda-web help`.
- AWS credentials for a development account with permission to create the
  resources declared in `infra/terraform` and deploy Lambda Web Functions.
- Access to Lambda Web Functions in the selected region.

Use your own CLI profile and region:

```bash
export AWS_PROFILE=my-development-profile
export AWS_REGION=us-east-1
aws sts get-caller-identity
nvm use
npm ci
```

No account number, deployed URL, or administrator password is supplied by this
repository. Terraform state and local variable files are ignored by Git; keep
them private and backed up. A team deployment should configure an appropriately
secured remote state backend.

## Create the supporting infrastructure

Choose an independent Terraform workspace with a short environment name:

```bash
export TRIVIA_ENV_NAME=dev
cp infra/terraform/terraform.tfvars.example infra/terraform/terraform.tfvars
scripts/terraform.sh init
scripts/terraform.sh plan
scripts/terraform.sh apply
npm run build
scripts/seed.sh
```

Review the plan before applying. Set `primary_region` in the local variable
file to your selected region. Environment names use 1–20 lowercase letters,
digits, or hyphens, start with a letter, and cannot contain consecutive or
trailing hyphens. `default` is reserved.

`TRIVIA_ENV_NAME=dev` produces names such as `serverlessq-dev-api`,
`serverlessq-dev-web`, and `dev-serverlessq-games`. Keep the same environment,
account, and region selected for deployment, seeding, and cleanup. Unset
`TRIVIA_ENV_NAME` to use the default workspace and its configurable resource
names. Named workspaces derive their names and table prefix automatically.

The seed creates the `AWS Trivia Sample` question set. It adopts an existing
set with that name, skips existing questions by text, and moves older matching
questions into the set. It uses AWS DynamoDB, including during local
development.

## Administrator bootstrap

Terraform creates a Cognito user pool, a public SPA app client without a client
secret, and an `admins` group. Self-registration is disabled. A bootstrap
operator with Cognito administrator permissions must create each user and add
them to that group:

```bash
export COGNITO_REGION="$(scripts/terraform.sh output -raw cognito_region)"
export COGNITO_USER_POOL_ID="$(scripts/terraform.sh output -raw cognito_user_pool_id)"
export COGNITO_APP_CLIENT_ID="$(scripts/terraform.sh output -raw cognito_app_client_id)"

# Replace this address with the administrator's address. Cognito sends the
# invitation and temporary password; do not put passwords in Terraform.
export ADMIN_EMAIL=administrator@example.com
aws cognito-idp admin-create-user \
  --user-pool-id "$COGNITO_USER_POOL_ID" \
  --username "$ADMIN_EMAIL" \
  --user-attributes Name=email,Value="$ADMIN_EMAIL" Name=email_verified,Value=true \
  --desired-delivery-mediums EMAIL \
  --region "$COGNITO_REGION"
aws cognito-idp admin-add-user-to-group \
  --user-pool-id "$COGNITO_USER_POOL_ID" \
  --username "$ADMIN_EMAIL" \
  --group-name admins \
  --region "$COGNITO_REGION"
```

Open `/admin`, sign in, and complete the required first-login password change.
The browser uses Cognito SRP authentication and stores its authenticated
session in session-scoped storage. Access tokens expire after 15 minutes and
refresh tokens after 8 hours. Admin API calls fetch a current access token.
Sign-out clears browser storage immediately and gives Cognito revocation up to
two seconds. After that deadline, the retired authentication worker is
terminated and its pending requests are denied.

The API validates the access token's signature, issuer, client, token type, and
expiry before checking `cognito:groups`. Missing or invalid identity returns
`401`; a valid user outside `admins` receives `403`. Public game routes do not
require a Cognito identity.

Verification uses the pool's public signing keys and does not query user status
on each request. Already issued access tokens can remain accepted until their
15-minute expiry after a user is disabled, removed from `admins`, or signed out.
Refresh-token revocation prevents further renewal but does not immediately
invalidate those offline-verified access tokens. Missing configuration or
unavailable signing keys returns `503 AUTH_UNAVAILABLE`.

The sample pool does not enable MFA because the included sign-in UI handles the
initial-password challenge but not Cognito MFA setup or TOTP challenges. For a
production adaptation, add those challenge flows and then require TOTP MFA in
the user pool; enabling MFA without the UI support will prevent administrators
from completing sign-in.

## Local development

Local API development uses your workspace's AWS tables and Cognito pool:

```bash
export DDB_REGION="$(scripts/terraform.sh output -raw ddb_region)"
export SERVERLESSQ_TABLE_PREFIX="$(scripts/terraform.sh output -raw table_prefix)"
export COGNITO_REGION="$(scripts/terraform.sh output -raw cognito_region)"
export COGNITO_USER_POOL_ID="$(scripts/terraform.sh output -raw cognito_user_pool_id)"
export COGNITO_APP_CLIENT_ID="$(scripts/terraform.sh output -raw cognito_app_client_id)"
export WEB_ORIGIN=http://127.0.0.1:5173
make run-api
```

In a second terminal, supply the same Cognito settings and run `make dev-web`.
For Vite, export them as `VITE_COGNITO_REGION`, `VITE_COGNITO_USER_POOL_ID`, and
`VITE_COGNITO_APP_CLIENT_ID`; the built web host uses the unprefixed names.
Open `http://127.0.0.1:5173`. For the built frontend, use
`WEB_ORIGIN=http://127.0.0.1:3001 make run-api` and `make run-web`, then open
`http://127.0.0.1:3001`. With `NODE_ENV=development` and no `WEB_ORIGIN`, only
`http://127.0.0.1:5173` is allowed; explicit configuration replaces that default.

The API binds to `127.0.0.1:3000`, the built web host to `127.0.0.1:3001`, and
Vite to loopback port `5173`. `AWS_LAMBDA_HTTP_ENDPOINT` overrides the server
bind address in Lambda. `API_BASE_URL` configures the built web host;
`VITE_API_BASE_URL` configures the development frontend. `/config.json`
publishes the API URL and Cognito identifiers as public runtime settings.
These identifiers are configuration, not credentials.

## Deploy

With infrastructure applied and the same environment selected:

```bash
scripts/deploy.sh
```

The default workflow deploys the API, deploys the web function with that API's
URL, and publishes an API revision with the exact deployed web origin allowed.
The script builds and packages each function, uploads its ZIP to the private
code bucket, and waits for an active endpoint. Subsequent deployments create
new revisions; the `home` endpoint follows the latest active revision.

Targeted deployments are available with `scripts/deploy.sh api` and
`scripts/deploy.sh web`. When updating only the API, preserve the exact web
origin through `WEB_ORIGIN`. Use the URLs printed by deployment, then verify
`/api/health` and open the web endpoint. Create a game in `/admin`, choose the
seeded question set, open its host view, and share the game-specific join URL.

### Browser origins and endpoint controls

`WEB_ORIGIN` is a comma-separated list of exact HTTP or HTTPS origins, for
example `https://web.example.com`. Supply scheme, hostname, and port when
needed. Wildcards, credentials, paths, query strings, and fragments are not
accepted. Production browser access is denied until an origin is configured.
Requests without an `Origin` header remain usable by service clients.
Rejected origins receive no CORS allow headers; the HTTP response can still be
successful. This also applies to `/api/health`.

CORS is a browser policy, not authorization. A caller outside a browser can
still invoke anonymous player routes. Cognito independently protects
administration routes.

New endpoints use a rate limit of `100` requests/second and a maximum of `10`
execution environments per region. Override them explicitly when needed:

```bash
ENDPOINT_RATE_LIMIT=200 ENDPOINT_MAX_ENVIRONMENTS=5 scripts/deploy.sh
```

`ENDPOINT_RATE_LIMIT` accepts `0`, 100–1000 in steps of 100, or 2000–10000 in
steps of 1000. Zero blocks requests. `ENDPOINT_MAX_ENVIRONMENTS` accepts
integers from 2 to 10000. Increasing either value increases potential spend;
these controls do not guarantee a budget. Creation always includes both
controls, including optional MultiRegion endpoints. Targeted revision updates
and existing MultiRegion endpoints preserve their current endpoint controls;
review and configure those limits separately if deploying to an older endpoint.
The API also caps SSE streams inside each execution environment at 50 per game
and 100 total, and closes streams after publishing a game's final snapshot.
These are per-environment safeguards rather than distributed global quotas.
For stricter production controls, put CloudFront and AWS WAF in front of the
endpoint or add a shared quota store.
Deployment also creates the function's exact CloudWatch log groups and sets
14-day retention. Override it with a supported CloudWatch Logs value, for
example `LOG_RETENTION_DAYS=30 scripts/deploy.sh`. The deploying identity needs
permission to create those groups and set their retention policy. Structured API
request and unhandled-error logs include the Lambda Web Function request ID so a
client-visible failure can be correlated with its CloudWatch records.
The HomeRegion workflow requires an active `home` endpoint in `LatestRevision`
mode with one revision serving 100% of traffic. It verifies the returned
revision, its configuration, and the effective endpoint controls before
reporting success. An endpoint whose effective rate is zero uses these
control-plane checks and skips HTTP smoke requests; traffic-enabled API
endpoints must still pass `/api/health`.

### Optional MultiRegion endpoint

Set `replica_regions` to supported additional regions, apply Terraform, and
deploy the current API revision before creating the optional endpoint:

```bash
scripts/deploy.sh api multi-region
```

This publishes the revision already serving `home` to an additive `global`
endpoint. It verifies region configuration and leaves the home endpoint
unchanged. Data stays in the primary region, so remote requests incur
cross-region latency and transfer costs. To use this API endpoint from the
frontend, deploy the web function with its printed URL as `API_BASE_URL` and
retain the web origin in the API's `WEB_ORIGIN` setting.

## Security, cost, and sample limitations

Keep the endpoint controls finite and monitor AWS spending. Costs include
Lambda requests and execution, DynamoDB requests and storage, Cognito usage,
S3 deployment versions, CloudWatch logs and metrics, and data transfer. SSE
connections are long-lived requests, and polling continues while users are
connected. Additional serving regions add capacity and cross-region traffic.
Use AWS Budgets alerts and remove the sample after use.

Lambda Web Function endpoints use `ApplicationManaged` authentication. The
Lambda service therefore accepts the HTTP request without authenticating it:
anonymous player routes are intentionally public, while the application
validates Cognito access tokens and `admins` group membership for every
administrator route. Organizations that prohibit application-managed endpoint
authentication can enforce their policy with the
`lambda:Request/WebFunctionAuthType` condition key in an SCP or IAM policy.

Administrator tokens are held in `sessionStorage`, so browser script injection
would still be able to read them. The web host sends a Content Security Policy
that restricts scripts and workers to same-origin files, limits network
connections to the configured API and Cognito endpoint, blocks framing and
plugins, and sends additional browser security headers. Chakra/Emotion requires
inline styles, so `style-src` permits inline CSS; inline scripts and `eval`
remain disallowed. Treat third-party frontend changes as security-sensitive.

All six DynamoDB tables enable point-in-time recovery. It adds backup storage
costs and supports recovery into a new table; restoring and switching the
application to restored tables remain operator tasks. The tables retain
DynamoDB's default AWS-owned encryption rather than a customer-managed KMS
key. This keeps the educational sample's deployment and cleanup lifecycle
small, but does not provide customer-controlled key policy, revocation, or KMS
use auditing. Reassess that accepted tradeoff and design key retention and
recovery before storing sensitive or regulated production data. The private S3 artifact
bucket keeps versioning and public access blocks enabled and retains S3's
default encryption at rest. A lifecycle rule expires noncurrent ZIP versions
after 30 days and aborts incomplete multipart uploads after 7 days. Current
objects remain until cleanup. Keep any deployment versions you need for
longer-term rollback elsewhere; artifacts can be rebuilt from source.

The artifact bucket has no cross-region replication, upload-event consumer,
or S3 server access logging; deployment-artifact access is not recorded by S3
access logs. It uses S3-managed encryption rather than KMS-by-default and
stores neither Terraform state nor player records. These four design choices
have resource-specific Checkov exceptions in `infra/terraform/s3.tf` and exact
matching rationale in `scripts/scanners/checkov-exceptions.json`. Versioning
is checked through the full Terraform graph without an exception.

The API accepts uncompressed JSON bodies up to 16 KiB. Larger bodies return
`413`, compressed request bodies return `415` without decompression, and
malformed JSON returns `400`. The root and deployment locks include patched
body-parser and qs releases, and the shipped API uses Zod 4.6.6 or newer.
The root development dependency graph may contain an older Zod release through
developer-only tooling; it is not part of the API deployment lock.
Size limits bound per-request parsing work but do not prevent anonymous callers
from spending the endpoint's allowed request rate or issuing many small
requests. Apply workload-specific abuse controls before production use.

This sample deliberately leaves production work to the deployer:

- Players are anonymous. Player identifiers stored by the browser are not
  authenticated identities. They are omitted from public leaderboard responses,
  but the sample does not provide full player authentication or comprehensive
  anti-cheat protection if an identifier is otherwise disclosed.
- Configure account controls, stronger administrator policies, MFA,
  audit requirements, and application-specific protection before any
  production use.
- Tables use on-demand capacity and point-in-time recovery. Disaster recovery
  procedures, a private data plane, and a production state backend require
  additional design.
- DynamoDB deletion protection is intentionally disabled so the confirmed
  sample teardown can remove the environment. Enable it for retained production
  data and require a reviewed process to disable it before an intentional
  deletion.
- DynamoDB TTL is enabled for an `expiresAt` attribute, but the application
  does not populate that field. Data is not automatically expired.
- Round scoring claims and per-player writes reduce duplicate settlement,
  but partial failures during scoring still require recovery design.
- Public game links and display names are visible to other players. Use
  sample data; do not collect sensitive information. Display names are
  compatibility-normalized and whitespace-normalized, and an illustrative
  blocklist rejects a few obvious test terms. Treat names as untrusted content
  and use a maintained moderation system for real audiences.
- Cleanup deletes game data and all code-bucket object versions. Export any
  data you want to retain before cleanup.

The repository has no measured production capacity or availability guarantee.

## Tests

```bash
npm run build
npm --workspace @serverlessq/web run build
npm run lint
npm test
npm run test:scripts
```

Unit and script tests use isolated fixtures and fake AWS commands. The
integration suite uses real DynamoDB and AWS credentials:

```bash
npm run test:integration
```

Run it only against isolated test tables. See
`packages/shared/src/repositories/repositories.integration.test.ts` for its
environment setup and table lifecycle.

### Publication checks

The GitHub workflow runs Node.js 24 build/lint/unit/script checks, Terraform
validation and three mock-provider test suites, source scanners, and
documentation links. It uses read-only repository permissions and needs no
AWS credentials. It never deploys or runs the live integration suite.

The Terraform gate requires exactly Terraform 1.16.3 and uses the committed
provider lock without updates. Mock-provider tests require Terraform 1.7 or
later even though infrastructure deployment supports 1.6.

Install scanner tools outside the repository using Node.js 24, Python 3.12,
`curl`, and `tar`:

```bash
node scripts/install-scanners.mjs \
  --destination /tmp/serverlessq-publication-tools --python python3.12
npm run check:terraform
npm run scan:local -- --tools /tmp/serverlessq-publication-tools
```

Choose an empty installation directory. The installer supports Linux x86-64
and macOS ARM64. Binary releases use
tracked SHA-256 checksums; each Python scanner has its own virtual environment
and a complete hash-locked dependency set. Tool versions are recorded in
`scripts/scanners/versions.json`. Downloads require network access.

Scanners operate on a snapshot of the Git index, including staged changes:
Gitleaks checks tracked source, Semgrep checks JavaScript/TypeScript with the
project's security rules, Bandit checks all tracked Python, and Checkov
evaluates the complete Terraform graph. Missing tools/reports, findings,
parser errors, empty inputs, and undocumented Checkov skips fail the gate.
Reports are written to a temporary directory printed by the runner.
Semgrep's project rules cover common Node, Express, and browser hazards; they
do not establish comprehensive security coverage. Inline Semgrep suppressions
are disabled. Bandit's only suppressions are two exact, test-harness-only
dispositions recorded in `scripts/scanners/bandit-exceptions.json`; bare or
additional suppressions fail the gate. Link exclusions also fail the gate.

Checkov rule `CKV_AWS_119` requires customer-managed KMS keys. The six tables
use DynamoDB's AWS-owned default encryption, so their resource-local skips are
accepted policy deviations, not false positives. Each skip is locked to its
exact resource and rationale in `scripts/scanners/checkov-exceptions.json`.
Use customer-managed keys, with deliberate key access, retention, restore, and
cleanup procedures, when production requirements need customer key control or
auditing.

The local link check validates files and fragments offline. CI also checks
external links and all retained publication history. Run the complete gate
only in a full checkout of the history that will actually be published:

```bash
node scripts/run-publication-scans.mjs all --online \
  --tools /tmp/serverlessq-publication-tools
```

An offline pass does not establish that external links work. A source-tree
scan does not establish that retained Git history is free of secrets.

## Contributing, security, and license

See [CONTRIBUTING.md](CONTRIBUTING.md) before opening an issue or pull request.
Report vulnerabilities using the private channels in [SECURITY.md](SECURITY.md),
not a public issue. Community participation is governed by
[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). The human maintainers are listed in
[MAINTAINERS.md](MAINTAINERS.md); a GitHub `CODEOWNERS` file requires the
destination repository's actual usernames or owning team.

This sample is licensed under the [MIT No Attribution license](LICENSE).

## Cleanup

Use the same environment and AWS credentials used during deployment:

```bash
export TRIVIA_ENV_NAME=dev
scripts/teardown.sh --dry-run
scripts/teardown.sh
```

Review the targets shown by the dry run. Cleanup deletes the selected
environment's Lambda Web Functions, endpoints and revisions, Terraform
resources, code-bucket versions, and associated function log groups. The
interactive command requires typing `destroy`. `--yes` is available for
intentional automation. Cleanup is destructive and cannot recover game data.
Check the account afterwards for any resources created outside these scripts.
