# Development Log - Rocky Surf

## About This Project

Rocky Surf is an open-source, self-hosted control plane for provisioning cloud dev boxes preloaded with AI coding agents. A user runs one small app (`npx rockysurf` or Docker), points it at their own cloud account (AWS, Hetzner, or any provider with a plugin), picks a "surge pack" (a curated tool bundle like Claude Code, Codex, or Amp), and gets a persistent, SSH-able Ubuntu machine with the tools installed and repositories cloned — under their own budget cap. It began life as a hosted SaaS on AWS serverless (see entries through 2026-02-18); in August 2026 it pivoted to open source with a pluggable provider architecture, and the SaaS-era control plane was replaced wholesale.

**Status:** Active
**Started:** 2026-02-01
**Last Updated:** 2026-08-13

---

## 2026-02-01 - Project Inception

Rocky Surf started with a clear vision: make it dead simple to provision cloud dev environments for AI coding agents. The initial planning phase produced a comprehensive PRD and a backlog of 54 beads issues covering five epics: Project Foundation, Server Management, GitHub Integration, Deployment & Hosting, and Real-time Updates.

The architecture was designed around AWS serverless: Lambda functions for the backend API, DynamoDB for data persistence, API Gateway for HTTP routing, and CloudFormation templates to provision EC2 instances on-demand. The frontend would be a React SPA hosted on S3/CloudFront.

Two types of GitHub integration were identified as necessary: (1) a GitHub OAuth App for user authentication ("Sign in with GitHub"), and (2) a GitHub App for granting provisioned EC2 instances access to clone repositories.

---

## 2026-02-02 - Phase 1 Foundation Build

The initial codebase structure was established with a TypeScript backend (Node.js 20, esbuild for bundling) and a React 19 + Vite 7 frontend. CloudFormation templates were created for DynamoDB tables (users, sessions, servers) and API Gateway.

Server management Lambdas were implemented: create, list, get, start, stop, terminate, plus a CloudFormation status polling function for tracking EC2 provisioning progress. EC2 templates support both On-Demand and Spot instances with three size tiers (small/medium/large mapping to t3.medium/large/xlarge).

The OAuth flow was built with two Lambdas: `initiateOAuth` generates a state token and redirects to GitHub, `oauthCallback` exchanges the code for an access token, creates/updates the user record in DynamoDB, creates a session, and returns a JWT to the frontend.

The frontend authentication system uses React Context to manage auth state, stores the JWT in localStorage, and automatically attaches Bearer tokens to API requests.

---

## 2026-02-02 - Deployment Adventures

Deployment revealed several infrastructure gaps that required debugging in production:

**S3 Public Access Blocked:** The initial plan was to use S3 static website hosting with a public bucket policy. AWS account-level Block Public Access settings prevented this. Rather than disable those security settings, the decision was made to use CloudFront with Origin Access Control (OAC) - a more secure approach that also provides CDN benefits for international users.

**Lambda Packaging Issues:** The esbuild config outputs `.mjs` files (ES modules) but the deploy script was looking for `.js` files. Additionally, handlers are output into subdirectories (`auth/initiateOAuth.mjs`), so CloudFormation handler paths needed the directory prefix (`auth/initiateOAuth.handler`).

**API Gateway Missing Integrations:** The API Gateway CloudFormation template created the URL path resources (`/auth/github`, `/servers`, etc.) but didn't create the actual HTTP methods or Lambda integrations. This was a significant oversight - the paths existed but returned "Missing Authentication Token" because nothing was wired up. Added all method definitions and Lambda proxy integrations to `lambdas.yaml`.

**Double-Slash URL Bug:** The frontend concatenated `${API_BASE_URL}/auth/github` but the API URL already ended with a trailing slash, producing `dev//auth/github`. Fixed by stripping trailing slashes from the base URL.

**Missing /user Endpoint:** After OAuth redirect, the frontend called `/auth/me` to fetch user info, but this endpoint didn't exist. Created `getMe.ts` Lambda and wired it to `GET /user` with proper CORS headers.

The deployment script evolved into a 7-step process: DynamoDB → API Gateway → Backend build/upload → Lambda stack → S3 bucket → CloudFront → Frontend sync.

---

## 2026-02-03 - Backend Testing Infrastructure

With the core functionality in place, focus shifted to establishing a proper testing foundation. The approach followed the "Testing Trophy" methodology: prioritize integration tests over unit tests, since Lambda handlers with mocked AWS services provide the best confidence-to-effort ratio.

### Testing Stack

Chose Vitest for the test runner (ESM-native, TypeScript support, fast) and `aws-sdk-client-mock` for mocking AWS SDK v3 clients. The setup required some finesse - the DynamoDB mock needs to intercept the actual `docClient` instance from `db.ts`, not just the generic `DynamoDBDocumentClient` class, otherwise mocks don't apply to the imported client.

### Test Infrastructure Created

The test helpers evolved into a clean structure:
- `test/setup.ts` - Environment variables and shared DynamoDB mock initialization
- `test/helpers/eventBuilder.ts` - Factory functions for `APIGatewayProxyEvent` objects with a fluent `withAuth()` helper
- `test/helpers/tokens.ts` - JWT token generators (valid, expired, invalid signature, malformed)
- `test/helpers/mockAws.ts` - Convenience wrappers for common DynamoDB mock patterns
- `test/fixtures/` - Realistic test data for users, sessions, and servers

### Coverage Achieved

Wrote 164 tests across 14 test files covering every Lambda handler:

| Category | Files | Tests |
|----------|-------|-------|
| Unit (pure functions) | `response.ts`, `types.ts` | 25 |
| Auth integration | `auth.ts`, `getMe.ts`, `initiateOAuth.ts`, `oauthCallback.ts` | 55 |
| Server operations | `listServers.ts`, `getServer.ts`, `createServer.ts`, `startServer.ts`, `stopServer.ts`, `terminateServer.ts`, `pollStackStatus.ts` | 73 |
| GitHub integration | `listRepositories.ts` | 11 |

The tests verify real business logic: status codes, response shapes, error messages, cost calculations, uptime tracking, OAuth state management (CSRF protection), and data transformations. For handlers that call external APIs (GitHub), `global.fetch` is mocked to simulate responses.

### Quality Assessment

Ran the tests through code review agents to verify they weren't just "mock tests." The verdict: tests exercise real handler code and verify meaningful outcomes. The mocks serve their proper purpose - isolating external dependencies while allowing application logic to execute.

However, the review identified gaps worth addressing:
- Missing verification of AWS command parameters (tests don't assert that correct queries are constructed)
- No AWS failure scenario tests (what happens when DynamoDB throttles or EC2 fails?)
- Time-dependent uptime calculations could be flaky without `vi.useFakeTimers()`

These are valid improvements for a future pass. For now, the 164 passing tests provide a solid safety net for refactoring and feature work.

---

## 2026-02-03 - OAuth Verification & EC2 Templates

### OAuth Flow Verified End-to-End

Returning to the project, the first priority was confirming the OAuth flow wasn't just showing mock data. A deep investigation using CloudWatch logs and DynamoDB queries proved the flow is fully functional:

- Found real user data in `rocky-surf-users-dev`: the operator's GitHub ID, username, email, avatar URL, and a real GitHub access token (`gho_*` format)
- CloudWatch logs showed actual API latency (~1.8 seconds for the callback Lambda), confirming real GitHub API calls
- Multiple sessions created over multiple days with proper 7-day TTL expiration

This closed out the OAuth-related beads issues (`rockysurf-whf` and `rockysurf-z3o`). The Authentication System epic is effectively complete.

### EC2 CloudFormation Templates

With auth settled, focus shifted to the Server Provisioning Backend epic. The EC2 templates existed in skeleton form but needed real UserData scripts to install the development tools.

The initial UserData approach used `npm install -g` for tools like Claude Code and `pip install` for Beads. Both failed spectacularly on Ubuntu 24.04:

1. **npm global installs as non-root fail** - The rocky user doesn't have permission to write to `/usr/lib/node_modules`
2. **pip blocked by PEP 668** - Ubuntu 24.04 marks Python as "externally managed" and refuses pip installs without `--break-system-packages` or a venv
3. **agent-deck doesn't exist on npm** - The package name was wrong; it's distributed via install script

The fix was to use official install scripts instead:
- Claude Code: `curl -fsSL https://claude.ai/install.sh | bash`
- Beads: `curl -fsSL https://raw.githubusercontent.com/steveyegge/beads/main/scripts/install.sh | bash`
- Agent Deck: `curl -fsSL https://raw.githubusercontent.com/asheshgoplani/agent-deck/main/install.sh | bash`
- Beads Viewer: `pipx install beads-viewer` (pipx handles PEP 668 cleanly)

The On-Demand template (`ec2-ondemand.yaml`) was tested end-to-end: stack creates successfully, SSH works, all tools install correctly (Claude Code v2.1.30, Beads v0.49.3, Agent Deck v0.10.10, Playwright with Chromium).

### Spot Instance Complications

The Spot template (`ec2-spot.yaml`) required additional fixes:

1. **SecurityGroupIds in Launch Templates** - Can't use `!Ref SecurityGroup` at the top level; need `NetworkInterfaces` block with `!GetAtt SecurityGroup.GroupId`
2. **ASG doesn't support persistent spots** - Changed from `SpotInstanceType: persistent` to `one-time`
3. **aws CLI not installed before EIP association** - The UserData tried to run `aws ec2 associate-address` before `apt-get install awscli`. Reordered to install awscli first.

The ASG creates and launches spot instances successfully. One remaining issue: the EIP auto-association in UserData isn't working reliably yet. The instance gets an auto-assigned public IP and is fully reachable, but the Elastic IP doesn't attach. This is a polish item - the core functionality works.

### Closed Issues

- `rockysurf-whf` - GitHub OAuth initiation Lambda
- `rockysurf-z3o` - GitHub OAuth callback Lambda
- `rockysurf-xqv` - On-Demand EC2 CloudFormation template
- `rockysurf-rxh` - Spot Instance EC2 CloudFormation template

### Next Up

The EC2 templates unblock `rockysurf-odp` (create server Lambda), which is the centerpiece of the Server Provisioning Backend epic. Also ready: the CloudFormation status polling Lambda (`rockysurf-15a`) and frontend auth context (`rockysurf-cct`).

---

## 2026-02-03 - WebSocket Real-Time Updates & Frontend Dashboard

### Backlog Audit

Before diving into new feature work, an audit of the beads tracker revealed that many tasks were already substantially complete from the Phase 1 build but hadn't been formally closed. Closed a batch of issues that were already implemented: `rockysurf-odp` (create server Lambda), `rockysurf-aqi` (list servers Lambda), `rockysurf-bbm` (JWT middleware), plus five frontend tasks (`rockysurf-0ir`, `rockysurf-cct`, `rockysurf-cms`, `rockysurf-dkk`, `rockysurf-41t`, `rockysurf-966`). This housekeeping cleared the way to focus on the genuinely incomplete work.

### WebSocket Backend

The WebSocket epic (`rockysurf-klm`) was the biggest piece of remaining backend work. The API Gateway WebSocket API already existed in CloudFormation, but the `$connect` and `$disconnect` routes pointed to placeholder Lambdas that returned 200 without doing anything useful.

Built the real handlers: `$connect` validates the JWT token from the query string, stores the connection ID and user ID in the `rocky-surf-connections-dev` DynamoDB table, and `$disconnect` cleans it up. A `broadcastToUser` utility queries the connections table for a given user ID and posts messages to all active connections via the API Gateway Management API.

The key integration point was `pollStackStatus` - the EventBridge-triggered Lambda that checks CloudFormation stack progress. Wired it to call `broadcastToUser` whenever a server's status changes, sending messages like `{ type: "server-status", serverId, status: "running", outputs: { instanceId, elasticIp } }`. This required adding `execute-api:ManageConnections` permissions and the WebSocket endpoint URL as environment variables.

Replaced the placeholder Lambda code in the WebSocket CloudFormation template with the real S3-deployed handlers and redeployed.

### Logout

The frontend had a logout button, but it only cleared the local JWT - it didn't invalidate the server-side session. Implemented a `logout` Lambda that deletes the session from DynamoDB and wired it to `POST /auth/logout` on API Gateway. The frontend now calls this endpoint before clearing local state.

### GitHub App Installation Detection

Implemented the `installationStatus` Lambda (`GET /github/installation`) which checks whether the authenticated user has the Rocky Surf GitHub App installed. It first checks the user's `installationId` field in DynamoDB. If null, it does a live re-check against the GitHub API (`GET /user/installations`) using the user's access token, and persists the result so subsequent calls are fast.

The `listRepositories` Lambda was also connected - it uses the installation ID to call GitHub's `GET /installation/{id}/repositories` endpoint, returning only repos the user has granted access to (not all repos the user owns).

### Frontend WebSocket Client

Built a three-layer WebSocket architecture for the frontend:
1. **`lib/websocket.ts`** - Low-level `WebSocketManager` class with auto-reconnect (exponential backoff, 1s-30s, jitter, 10 attempts max)
2. **`contexts/WebSocketContext.tsx`** - React Context that connects when authenticated, disconnects on logout
3. **`hooks/useServerUpdates.ts`** - Consumer hook that filters for `server-status` messages with optional server ID filtering

The `DashboardPage` subscribes to all server status updates and patches the matching server's status in-place. The `ServerDetailPage` re-fetches the full server record on any status change for its server ID. A connection status indicator appears in the UI when the WebSocket is connecting or reconnecting.

### First GitHub App Detection Bug (`rockysurf-3dd`)

After deploying everything, testing revealed the Create Server page always showed "Install GitHub App" even after the app was installed. The frontend was calling `GET /repos` directly on mount - if the user installed the app after logging in, `installationId` was null in DynamoDB and the repos endpoint returned 400.

Fixed the frontend flow: `CreateServerPage` now calls `checkInstallation()` before `listAuthorizedRepositories()`, giving the backend a chance to detect the installation via the GitHub API. Also fixed the repos endpoint path (`/github/repositories` should have been `/repos`).

This appeared to work, but the bug would resurface the next day with a deeper root cause.

---

## 2026-02-04 - Repo Search/Filter & The OAuth App vs GitHub App Reckoning

### Repository Search and Filtering

Two quality-of-life features for the Create Server page: removed the artificial 20-repo limit (previously `repositories.slice(0, 20)`) and added a search input that filters repos by name in real-time using `useMemo`. A counter shows "X of Y repositories" as the user types. The repo list container got a taller max-height (400px) since users can now see all their repos. Closed `rockysurf-c5p` and `rockysurf-bnf`.

### The Persistent GitHub App Detection Bug

After deploying the repo search feature, testing revealed that `rockysurf-3dd` was still broken - the Create Server page showed "Install GitHub App" even though the app was clearly installed. This bug had now persisted through multiple fix attempts, so the approach shifted to a thorough root cause investigation.

**Investigation trail:**

CloudWatch logs for the `installationStatus` Lambda showed `Failed to fetch GitHub installations: 403`. The backend was calling `GET /user/installations` with the user's stored access token and getting a 403 Forbidden response. The token in DynamoDB started with `gho_`.

First hypothesis: the `scope` parameter in the OAuth initiation URL was causing GitHub to issue a classic OAuth token instead of a GitHub App user access token. Removed the `scope` parameter from `initiateOAuth.ts` and redeployed. Re-authenticated - still got a `gho_` token and still 403.

**Root cause:** The project had two separate GitHub registrations: an **OAuth App** (client ID prefix `Ov23li`) and a **GitHub App** (client ID prefix `Iv23li`). All three Lambda environment variables (`GITHUB_CLIENT_ID`) were configured with the OAuth App's client ID. OAuth Apps produce `gho_` tokens (classic OAuth tokens), while GitHub Apps produce `ghu_` tokens (user access tokens). The `GET /user/installations` endpoint only accepts `ghu_` tokens.

This was confirmed by querying GitHub's public API (`GET /apps/rocky-surf`) which returned the GitHub App's actual client ID (`Iv23li` prefix), different from what the Lambdas had.

**The fix:**

Updated all three Lambdas (`initiate-oauth`, `oauth-callback`, `installation-status`) to use the GitHub App's client ID and client secret. Created a one-time shell script to securely update the credentials - it read the secret from a local file, applied it to the Lambda environment variables via `aws lambda update-function-configuration`, and deleted the file afterward. This avoided having the secret appear in chat logs or terminal history.

Also needed to add the callback URL to the GitHub App settings - it had only been configured on the old OAuth App.

**Verification:**

Tested end-to-end using browser automation: signed out, signed back in via GitHub (which now showed the proper GitHub App authorization page - "Rocky Surf by The Last Barron"), confirmed the token in DynamoDB was `ghu_` prefix, and verified the Create Server page loaded repositories correctly.

One minor casualty: `GET /user/emails` now returns 403 because the GitHub App doesn't have `email_addresses:read` permission. The `oauthCallback` Lambda handles this gracefully by returning null for the email, so it's not a blocker.

**Lessons learned:**

The reason this bug persisted through four fix attempts was that earlier iterations addressed symptoms (frontend flow, backend re-check logic, scope parameter) instead of the root cause (wrong client ID type). The `Ov23li` vs `Iv23li` prefix distinction and the `gho_` vs `ghu_` token type distinction were the critical clues. When a GitHub API returns 403, the first thing to check is whether you're using the right type of token for that endpoint.

### Closed Issues

- `rockysurf-c5p` - Infinite scroll / show all repos
- `rockysurf-bnf` - Search/filter input for repo list
- `rockysurf-3dd` - GitHub App installation not detected (root cause: wrong client ID type)

### Remaining Work

The old OAuth App can now be deprecated. The CloudFormation `lambdas.yaml` still has old default parameter values that should be updated before the next deploy. Adding `email_addresses:read` to the GitHub App permissions would restore email fetching.

---

## 2026-02-04 - Epic Verification & Deployment Gap Discovery

Shifted focus from feature work to systematically verifying and closing epics. This uncovered two deployment bugs that had been lurking undetected.

### Logout Lambda 502

Testing the Auth epic revealed the logout endpoint was returning 502. CloudWatch showed `Cannot find module 'logout'` — the `auth.zip` on S3 only contained 3 of 4 auth handlers because it was uploaded before `logout.ts` was written. The Lambda existed in CloudFormation (pointing to the zip), but the zip never had the file. Repackaged and redeployed.

This exposed a systemic gap: `deploy-backend.sh` uploads zips to S3 but doesn't call `aws lambda update-function-code`, so new code doesn't actually reach running Lambdas without a full CloudFormation stack redeploy. Documented this as AWS Learning #12 and created two issues: `rockysurf-3wd` (deploy script should update Lambda code after S3 upload, P1) and `rockysurf-y9z` (post-deploy smoke test script, P2).

The broader insight: "code in git" does not equal "code on S3" does not equal "code running in Lambda." All three must be verified. Behavioral tests against live endpoints are the only reliable check.

### Terminate Route Mismatch

Smoke testing all server provisioning endpoints found that `POST /servers/{id}/terminate` returned 403 ("Missing Authentication Token" — API Gateway's way of saying "no route found"). The API Gateway had `DELETE /servers/{id}` but the frontend sends `POST /servers/{id}/terminate` to match the start/stop pattern. Added the `/terminate` resource to `api-gateway.yaml`, wired up POST and OPTIONS methods in `lambdas.yaml`, and redeployed both stacks. All 12 API endpoints now return expected status codes.

### Epics Closed

- `rockysurf-42j` — Authentication System: OAuth login, JWT sessions, /user endpoint, logout all verified working.
- `rockysurf-2xg` — Project Foundation & Infrastructure: All 5 CloudFormation stacks healthy, all 5 DynamoDB tables active. Two remaining P2 consolidation tasks (master stack, S3+CF template) left as standalone items.

---

## 2026-02-04 - Resize Server Lambda & The Secrets Disaster

### Resize Server Implementation

Implemented `POST /servers/{serverId}/resize` — the first new server action Lambda since the initial build. This allows users to change instance size (small/medium/large) on stopped On-Demand servers by calling EC2 `ModifyInstanceAttribute` to swap the instance type.

The implementation followed the established `stopServer.ts` pattern closely: JWT auth, path param extraction, ownership verification, spot instance rejection, status validation (must be stopped), then the EC2 call, DynamoDB update, WebSocket broadcast, and response. The plan was decomposed into 5 beads sub-tasks with dependency chains (handler → tests, api-gateway → lambdas → deploy script), all blocking the parent `rockysurf-asd`.

One addition not in the original plan: `ec2:ModifyInstanceAttribute` had to be added to the IAM policy in `api-gateway.yaml`. The existing EC2 permissions only covered start/stop/describe operations.

The test suite (15 tests) caught an important pattern: `buildEvent()` auto-stringifies the `body` field, so passing `JSON.stringify({size: 'large'})` double-stringifies it. Tests that pass the body as a raw object work correctly. This is now documented in MEMORY.md to prevent future occurrences.

### Deployment Goes Sideways

Deploying the resize Lambda required a three-step process: (1) build and upload code to S3, (2) update the api-gateway stack for the new `/resize` resource and IAM permission, (3) update the lambdas stack for the new Lambda function and API methods.

Steps 1 and 2 went smoothly. Step 3 is where things went wrong. The `aws cloudformation deploy` command was called with `JWTSecret=UsePreviousValue` in `--parameter-overrides`, intending to retain the previous value. But `deploy` doesn't support `UsePreviousValue` syntax — it treated "UsePreviousValue" as the literal parameter value and set all three sensitive parameters (`JWTSecret`, `GitHubClientSecret`, `GitHubClientId`) to the string "UsePreviousValue".

This was immediately caught by checking the Lambda environment variables, but the damage was done. `GitHubClientId` could be restored from known values. `GitHubClientSecret` was recovered from `~/.rocky-surf-secrets`. But `JWTSecret` was a NoEcho CloudFormation parameter — unrecoverable once overwritten. A new 64-character JWT secret was generated with `openssl rand -base64 48` and saved to `~/.rocky-surf-secrets`. All existing user sessions were invalidated (users must re-login).

A second deployment mishap: the secrets file had no trailing newline, so `echo "JWT_SECRET=..." >> ~/.rocky-surf-secrets` appended directly to the end of the `GITHUB_CLIENT_SECRET` line, creating one long concatenated value. When sourced, the GitHub secret absorbed both values and the JWT secret was empty. Fixed the file and redeployed a third time.

The correct approach for `deploy` is to simply **omit** parameters you want to retain — they're kept automatically. For `update-stack`, use the proper `ParameterKey=X,UsePreviousValue=true` syntax. This distinction was already documented in MEMORY.md but the lesson clearly hadn't sunk in deeply enough. It has now.

### AWS Secrets Manager Epic

The deployment mishap became the catalyst for a long-overdue initiative: migrating all secrets to AWS Secrets Manager. Created epic `rockysurf-0dg` (P1) with 7 sub-tasks covering the full migration path:

1. Create Secrets Manager CloudFormation template (`rockysurf-uy6`)
2. Store JWT_SECRET (`rockysurf-9f4`)
3. Store GITHUB_CLIENT_SECRET (`rockysurf-bgi`)
4. Store GitHubAppToken (`rockysurf-6wi`)
5. Update Lambdas to read from Secrets Manager at runtime (`rockysurf-h0h`)
6. Update EC2 templates for Secrets Manager (`rockysurf-heb`)
7. Remove legacy secret storage (`rockysurf-0ps`)

The dependency chain ensures secrets exist before consumers are updated, and cleanup only happens after everything is migrated.

### Closed Issues

- `rockysurf-asd` — Implement resize server Lambda (parent)
- `rockysurf-09c` — resizeServer.ts handler
- `rockysurf-2j0` — resizeServer.test.ts tests
- `rockysurf-ecy` — API Gateway resize resource
- `rockysurf-tcd` — Lambdas stack resize entries
- `rockysurf-iof` — Deploy script update

---

## 2026-02-04 - Secrets Manager Migration Complete

### Epic Complete: `rockysurf-0dg`

Executed the full Secrets Manager migration in a single session — all 7 sub-tasks from planning to production.

**Infrastructure layer** (`rockysurf-uy6`): Created `infrastructure/secrets-manager.yaml` defining three `AWS::SecretsManager::Secret` resources (JWT, GitHub client secret, GitHub app token) with cross-stack ARN exports. Deployed as `rocky-surf-secrets-dev` — the new first stack in the deployment order, with no dependencies.

**Secret verification** (`rockysurf-9f4`, `rockysurf-bgi`, `rockysurf-6wi`): Verified JWT_SECRET and GITHUB_CLIENT_SECRET values match across all three sources: `~/.rocky-surf-secrets`, Secrets Manager, and the deployed Lambda environment variables (compared via MD5 hashes to avoid exposing values in logs). GitHubAppToken stored with a placeholder value for future use.

**Lambda migration** (`rockysurf-h0h`): The core change. Created `backend/src/lib/secrets.ts` — a Secrets Manager client with module-level caching so secrets are fetched once per Lambda cold start and reused for the container lifetime. The client instance is exported for test mocking.

Key code changes:
- `auth.ts`: `getJWTSecret()` removed (was reading `process.env.JWT_SECRET`), replaced by import from `secrets.ts`. `createToken()` changed from sync to async. `verifyToken()` now awaits the secret fetch.
- `oauthCallback.ts`: `getOAuthConfig()` changed from sync to async, calls `getGitHubClientSecret()` from `secrets.ts` instead of reading `process.env.GITHUB_CLIENT_SECRET`.
- `api-gateway.yaml` and `websocket-api.yaml`: Added `secretsmanager:GetSecretValue` to IAM policies scoped to `rocky-surf-*` secrets.
- `lambdas.yaml`: Replaced `JWTSecret` and `GitHubClientSecret` NoEcho parameters with `SecretsStackName` parameter. All `JWT_SECRET` env vars replaced with `JWT_SECRET_ARN` (imported from secrets stack). `GITHUB_CLIENT_SECRET` replaced with `GITHUB_CLIENT_SECRET_ARN`.
- `websocket-api.yaml`: Same treatment — `JWTSecret` param replaced with `SecretsStackName`, env var switched to ARN.
- Test setup: Added SecretsManager mock (`smMock`) alongside existing DynamoDB mock, with `clearSecretsCache()` called in `afterEach` to prevent cache leakage between tests.

All 227 tests pass. Deployed three stacks (api-gateway for IAM, then lambdas and websocket-api in parallel), uploaded new Lambda code, and smoke tested the live API.

**EC2 template migration** (`rockysurf-heb`): Updated both `ec2-ondemand.yaml` and `ec2-spot.yaml`. Replaced the `GitHubAppToken` NoEcho parameter with `GitHubAppTokenSecretArn`. Added `secretsmanager:GetSecretValue` to the EC2 instance IAM role. UserData now fetches the token at boot via `aws secretsmanager get-secret-value`, with a guard that skips the "placeholder" value.

**Cleanup** (`rockysurf-0ps`): Updated `AWS_LEARNINGS.md` with lesson #13 on secrets management. Updated `MEMORY.md` with the new secrets architecture and revised stack deployment order. Deploy script help text updated to reference `SecretsStackName` instead of secret parameters. `~/.rocky-surf-secrets` remains as a legacy backup but is no longer used by any infrastructure.

### Architecture: Before and After

**Before:** Secrets passed as CloudFormation `NoEcho` parameters at deploy time. Values baked into Lambda environment variables. Unrecoverable if overwritten. Each deployment required sourcing `~/.rocky-surf-secrets` and passing values on the command line.

**After:** Secrets stored in AWS Secrets Manager. Lambda env vars contain only ARNs pointing to secrets. Code fetches values at runtime (cached per cold start via `lib/secrets.ts`). EC2 instances fetch via AWS CLI at boot. Deployments no longer touch secret values — just reference the secrets stack name.

### Closed Issues

- `rockysurf-0dg` — Epic: Migrate secrets to AWS Secrets Manager
- `rockysurf-uy6` — Create Secrets Manager CloudFormation template
- `rockysurf-9f4` — Migrate JWT_SECRET to Secrets Manager
- `rockysurf-bgi` — Migrate GITHUB_CLIENT_SECRET to Secrets Manager
- `rockysurf-6wi` — Migrate GitHubAppToken to Secrets Manager
- `rockysurf-h0h` — Update Lambda functions to read secrets from Secrets Manager
- `rockysurf-heb` — Update EC2 templates to read GitHubAppToken from Secrets Manager
- `rockysurf-0ps` — Remove legacy secret storage after migration

---

## 2026-02-04 - Server Provisioning Epic Closed, E2E Testing Begins

### Epic Complete: `rockysurf-7rn` (Server Provisioning Backend P0)

Closed out the Server Provisioning Backend epic with the final four tasks:

**Add Repository Lambda** (`rockysurf-ahc`): Implemented `POST /servers/{serverId}/repositories` — allows adding GitHub repositories to an existing server. The handler validates the `owner/repo` format via regex, checks for duplicates in the server's repository array, then verifies the repo exists and is accessible via the GitHub API using the user's stored access token. If all checks pass, it appends the repo URL to the server record and returns the updated server object. 15 tests cover auth, validation, authorization, GitHub API error cases, and the happy path.

**Resize Server Modal** (`rockysurf-d63`): Frontend modal component with three size radio cards (Small $0.04/hr, Medium $0.08/hr, Large $0.17/hr). Current size highlighted with "(current)" label. Disabled states for spot instances ("Spot instances cannot be resized") and running servers ("Stop the server to resize"). Integrated with `ServerDetailPage` and new `resizeServer` API method.

**Provisioning Timeline** (`rockysurf-djk`): Three-step vertical progress indicator shown during server provisioning: "Creating infrastructure..." → "Installing tools..." → "Configuring GitHub access...". First step shows completed checkmark when server record exists, subsequent steps show spinners. Estimated time text: "~10-20 minutes". Also added inline spinner to the "Provisioning" status badge on dashboard server cards.

**E2E Test Checklist** (`rockysurf-5bb`): 14-point manual test document covering the full Rocky Surf flow from OAuth login through server termination. Includes tests for auth persistence, GitHub App installation detection, server creation, provisioning status, WebSocket real-time updates, SSH connection, stop/start/resize operations, the new add repository endpoint, and spot instance behavior.

### OAuth Credential Revert Incident

After deploying the epic, OAuth login started failing with "authentication_failed". Investigation revealed the Lambda logs were showing `GitHub OAuth error: The client_id and/or client_secret passed are incorrect.`

Root cause: When deploying the updated `lambdas.yaml` (which added the new addRepository Lambda), CloudFormation used the parameter values stored in the stack — which were the **old OAuth App credentials** (`Ov23li...`). A previous session had fixed OAuth by directly updating Lambda environment variables to use the GitHub App credentials (`Iv23li...`), but the CloudFormation template had no default values, so those direct updates were overwritten.

The fix was straightforward: redeploy with `--parameter-overrides GitHubClientId=<the GitHub App client id>`. But the deeper fix was updating `lambdas.yaml` to set sensible defaults for all GitHub-related parameters so this can't happen again:

```yaml
GitHubClientId:
  Type: String
  Default: <the GitHub App client id>
  Description: GitHub App Client ID (NOT the old OAuth App)
```

This incident yielded AWS Learning #15: direct Lambda env var updates are temporary fixes that get overwritten on the next CloudFormation deploy. Always update the template defaults too.

### E2E Testing: First Run

Began executing the E2E test checklist with browser automation:

| Test | Result |
|------|--------|
| 1. GitHub OAuth Login | ✅ Pass (after credential fix) |
| 2. Auth Persistence | ✅ Pass |
| 3. GitHub App Installation | ✅ Pass (repos visible) |
| 4. Create On-Demand Server | ✅ Pass (after S3 fix) |
| 5. Provisioning Status | ✅ Pass (timeline working) |
| 6-14. Remaining tests | ⏳ Blocked |

### Server Creation: Two Sequential Permission Failures

Creating a server initially failed with two distinct permission errors, each requiring infrastructure updates:

**First error: S3 Access Denied**

CloudFormation couldn't read the EC2 template from S3: `S3 error: Access Denied`. Initial assumption was that a bucket policy for `cloudformation.amazonaws.com` would help — but that's wrong. When a Lambda calls CloudFormation with `TemplateURL`, CloudFormation reads the template using the **caller's credentials** (the Lambda's IAM role), not as a service principal.

Fix: Added `S3TemplateAccess` policy to the Lambda execution role in `api-gateway.yaml`:
```yaml
- PolicyName: S3TemplateAccess
  PolicyDocument:
    Version: '2012-10-17'
    Statement:
      - Effect: Allow
        Action:
          - s3:GetObject
        Resource:
          - !Sub 'arn:aws:s3:::rocky-surf-deployments-${AWS::Region}/templates/*'
```

This became AWS Learning #13.

**Second error: SSM Parameter Access Denied**

After fixing S3, server creation got further but CloudFormation failed with: `User is not authorized to perform: ssm:GetParameters on resource: arn:aws:ssm:us-east-1::parameter/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id`

The EC2 templates use `AWS::SSM::Parameter::Value` to dynamically resolve the latest Ubuntu 24.04 AMI. CloudFormation needs `ssm:GetParameters` permission on AWS public parameters to resolve these values. The Lambda role lacks this permission.

Created bug `rockysurf-6mn` (P1) with the fix: add `SSMParameterAccess` policy granting `ssm:GetParameters` on `arn:aws:ssm:*::parameter/aws/service/*`.

### Session Status

Tests 1-5 pass. Server provisioning is blocked on `rockysurf-6mn` (SSM permissions). Once that's fixed, the created server should provision successfully and tests 6-14 can continue.

### Closed Issues

- `rockysurf-7rn` — Epic: Server Provisioning Backend (P0)
- `rockysurf-ahc` — Add repository Lambda
- `rockysurf-d63` — Resize server modal
- `rockysurf-djk` — Provisioning status with progress indicators
- `rockysurf-5bb` — E2E test checklist

### Created Issues

- `rockysurf-6mn` — Bug: Lambda role missing ssm:GetParameters for AMI lookup (P1)

---

## 2026-02-05 - E2E Tests Complete After Permission Gauntlet

### The Permission Discovery Process

Unblocking server provisioning turned into a multi-hour exercise in discovering exactly what IAM permissions a Lambda needs when it invokes CloudFormation to create EC2 infrastructure. The key insight — learned the hard way through repeated failures — is that CloudFormation uses the **caller's credentials** (the Lambda's IAM role) to create ALL resources in the template, not a CloudFormation service role. This means the Lambda role needs permissions for every resource type the template creates.

The permission gaps were discovered one by one as CloudFormation attempted to create each resource:

**1. SSM Parameters** (`rockysurf-6mn`): The EC2 template uses `AWS::SSM::Parameter::Value` to dynamically fetch the latest Ubuntu 24.04 AMI ID. CloudFormation couldn't resolve this because the Lambda role lacked `ssm:GetParameters` on AWS public parameter paths (`arn:aws:ssm:*::parameter/aws/service/*`).

**2. EC2 Security Groups**: Stack failed with `ec2:DescribeSecurityGroups not authorized`. The original EC2Access policy only covered instance operations (start/stop/describe) but the template creates security groups, elastic IPs, and other EC2 resources. Added comprehensive EC2 permissions: CreateSecurityGroup, DeleteSecurityGroup, AllocateAddress, ReleaseAddress, RunInstances, TerminateInstances, VPC describes, and tagging.

**3. IAM Roles and Instance Profiles**: Stack failed with `iam:GetRole not authorized` when trying to create the EC2 instance's IAM role and instance profile. The original policy only had `iam:PassRole`. Added full IAM lifecycle permissions: CreateRole, DeleteRole, GetRole, policy operations (Put/Delete/Attach/Detach), and the corresponding instance profile operations (Create/Delete/Get/AddRoleToInstanceProfile/RemoveRoleFromInstanceProfile). Also needed tagging permissions for both roles and instance profiles.

**4. Launch Templates and Auto Scaling** (for spot instances): Spot instances use Auto Scaling Groups with Launch Templates rather than direct instance launches. Added ec2:CreateLaunchTemplate, ec2:DeleteLaunchTemplate, and the full suite of autoscaling permissions.

**5. Stack Deletion Permissions**: After a spot instance test, the terminate operation failed with `autoscaling:DescribeScalingActivities not authorized`. This permission is only needed during stack deletion (to check scaling activity status), not creation. The DELETE_FAILED state left orphaned EC2 resources running and incurring costs. Added the missing permission and retried deletion successfully.

### E2E Test Results

With all permissions finally in place, server provisioning worked end-to-end. The full E2E test checklist was executed:

| Test | Result |
|------|--------|
| 1. GitHub OAuth Login | ✅ Pass |
| 2. Auth Persistence | ✅ Pass |
| 3. GitHub App Installation | ✅ Pass |
| 4. Create On-Demand Server | ✅ Pass |
| 5. Provisioning Status | ✅ Pass |
| 6. WebSocket Real-Time Updates | ✅ Pass |
| 7. Server Detail with Connection Info | ✅ Pass |
| 8. SSH Key Download | ⏭️ Skipped (needs local verification) |
| 9. Stop Server | ✅ Pass |
| 10. Resize Server | ✅ Pass |
| 11. Start Server | ✅ Pass |
| 12. Add Repository | ✅ Pass |
| 13. Terminate Server | ✅ Pass |
| 14. Spot Instance Create/Terminate | ✅ Pass |

Spot instance behavior was verified: no Stop button (spot instances can't be stopped), no Resize button (spot instances can't be resized), proper warning banner displayed.

### Documentation: AWS Learnings 17-20

The permission discoveries were generalized and documented in `AWS_LEARNINGS.md` as learnings 17-20:

- **#17**: CloudFormation uses caller credentials for ALL resource creation — audit your template for every `AWS::*` resource type
- **#18**: IAM resources require full role/instance-profile lifecycle permissions, not just PassRole
- **#19**: Stack deletion requires the same permissions as creation (plus more) — missing permissions cause DELETE_FAILED and orphaned resources
- **#20**: Spot instances via ASG require launch template and Auto Scaling permissions

The deployment checklist was updated with four new items covering these patterns.

### Closed Issues

- `rockysurf-6mn` — Lambda role missing ssm:GetParameters for AMI lookup

---

## 2026-02-05 - SSH Key Feature Complete & Server Provisioning Fixes

### SSH Key Download Feature

Implemented end-to-end SSH key generation and download functionality, allowing users to create servers with auto-generated SSH key pairs:

**Backend** (`rockysurf-85m`): The `createServer` Lambda now generates an EC2 key pair (ed25519) when no user SSH public key is provided. The private key is stored in SSM Parameter Store at `/rocky-surf/ssh-keys/{serverId}` as a SecureString. A new `getSshKey` Lambda retrieves the private key and returns it as a downloadable `.pem` file with proper Content-Type headers.

**Frontend** (`rockysurf-xu9`): Added "Download SSH Key" button to the server detail page, shown only when the server has a generated key (not user-provided). After download, a security warning reminds users to store the key safely with `chmod 400`.

**Permission Fix**: Initial deployment failed with `ssm:AddTagsToResource` permission denied — SSM Parameter Store requires this permission when storing parameters with tags. Added to the Lambda IAM policy.

### The Rocky User SSH Bug

Testing revealed that SSH connections as the `rocky` user failed with "Permission denied (publickey)" even though the key was valid. The investigation uncovered multiple issues in the EC2 UserData scripts:

**1. Beads Installation as Root**: The beads CLI was being installed as root (`curl ... | bash`), which put it in `/root/.beads/bin` instead of `/home/rocky/.beads/bin`. Fixed by wrapping the install in `sudo -u rocky bash << 'EOF'` heredoc, matching the pattern used for Claude Code, Playwright, and Agent Deck.

**2. SSH Key Copy Timing**: The UserData script copied `/home/ubuntu/.ssh/authorized_keys` to `/home/rocky/.ssh/authorized_keys`, but this happened before cloud-init had finished injecting the public key. The copy found an empty or non-existent file. Fixed by adding a wait loop (up to 60 seconds) that polls for the authorized_keys file to exist and have content before copying:

```bash
for i in {1..30}; do
  if [ -f /home/ubuntu/.ssh/authorized_keys ] && [ -s /home/ubuntu/.ssh/authorized_keys ]; then
    break
  fi
  sleep 2
done
```

**Design Decision Confirmed**: The `rocky` user is intentional — it provides a consistent SSH interface regardless of the underlying OS. Whether running Ubuntu, Amazon Linux, or Debian in the future, users always connect as `rocky@...`. This abstraction allows OS flexibility without changing user-facing documentation.

### New Issues Created

- `rockysurf-q62` (P2): Add SSH connection instructions to server detail page — show the full `ssh -i ~/.ssh/{serverName}.pem rocky@{elasticIp}` command with copy button
- `rockysurf-rtj` (P1): Server status not synced with AWS — the UI shows "Provisioning" even after a server is terminated in AWS. DynamoDB isn't being updated when CloudFormation stacks fail or are deleted.

### Closed Issues

- `rockysurf-85m` — Implement get SSH key Lambda
- `rockysurf-xu9` — Implement SSH key download button
- `rockysurf-dnu` — Fix tool installation running as root instead of ubuntu user

---

## 2026-02-05 - Real-Time Provisioning Progress & The Uncommitted Fix Mystery

### Feature: Real-Time Provisioning Progress (`rockysurf-9gk`)

Implemented a 7-step provisioning timeline that shows real-time progress from EC2 UserData. Previously, servers just showed "Provisioning" with no indication of what was happening inside the VM.

**EC2 UserData Reporting**: Added a `report_progress()` bash function to both EC2 templates that calls the API at each milestone:
1. `instance_launching` — Script starting
2. `instance_running` — SSH keys configured
3. `installing_tools` — Beginning tool installation
4. `tools_installed` — Claude Code, Beads, Playwright installed
5. `cloning_repos` — Cloning GitHub repositories
6. `ready` — Server fully provisioned

**Backend Changes**: Created `updateServerStatus` Lambda that accepts progress updates authenticated by a one-time provisioning token (not JWT — EC2 instances don't have user credentials). The token is generated in `createServer`, passed to CloudFormation, and stored in the server record. Each progress update broadcasts via WebSocket and updates `provisioningStep` in DynamoDB.

**Frontend Updates**: The `ProvisioningTimeline` component now shows all 7 steps with completed checkmarks, in-progress spinners, and pending states based on the current `provisioningStep`. Dashboard cards show a spinner next to "Provisioning" status.

### The Great Uncommitted Fix Disaster

After deploying the progress feature, testing revealed two P0 bugs that seemed unrelated:

**Bug 1 (`rockysurf-ghf`)**: Progress updates only showed step 1 ("Creating EC2"), then jumped directly to "Running". Steps 3-7 never appeared despite EC2 successfully calling `report_progress`.

**Bug 2 (`rockysurf-jdh`)**: SSH connections failed with "Permission denied (publickey)" even though keys were verified as created in AWS.

Hours of investigation ensued: template diffs, Lambda deployment verification, git history archaeology. Everything looked correct — templates matched S3, Lambda env vars were present, the code had the fix.

Then `git diff HEAD` revealed the truth: the fix to `pollStackStatus.ts` that prevents premature status changes had been **made locally but never committed or deployed**. The working directory had the fix, but the deployed Lambda still had the old code that set `status: 'running'` immediately when CloudFormation returned `CREATE_COMPLETE`.

**Root Cause**: CloudFormation `CREATE_COMPLETE` happens when infrastructure is ready, but EC2 UserData is still running. The old `pollStackStatus` set status to 'running' at this moment, which caused:
1. `updateServerStatus` to reject progress updates (server status ≠ 'provisioning')
2. Users to see "Running" and attempt SSH before UserData finished configuring SSH keys

**The Fix**: `updateServerSuccess()` now only updates `instanceId/elasticIp/publicDns` without changing status. Status stays 'provisioning' until EC2 calls `report_progress("ready")`.

**Lesson Learned**: Always verify uncommitted changes before debugging production issues. `git status` should be the first diagnostic step, not the last.

### Documentation Updates

Added frontend deployment reminder to `.claude/CLAUDE.md` — after any frontend changes, must run S3 sync and CloudFront invalidation. This came up because the new 7-step timeline wasn't appearing despite hard refreshes; the CloudFront cache was serving old assets.

### Closed Issues

- `rockysurf-9gk` — Real-time provisioning progress from EC2 UserData
- `rockysurf-ghf` — Provisioning progress updates missing for steps 3-7
- `rockysurf-jdh` — SSH keys not working on provisioned servers

**Note:** The root cause described above (uncommitted pollStackStatus changes) was incorrect. Both bugs were reopened and properly fixed in the next session — see 2026-02-05 entry "The Real Root Cause" below.

---

## 2026-02-05 - The Real Root Cause: awscli on Ubuntu 24.04

### Reopened P0 Bugs

After the previous session declared `rockysurf-ghf` and `rockysurf-jdh` fixed, live testing showed both bugs still present: the UI was stuck on provisioning step 2 ("Launching server") and SSH returned "Permission denied (publickey)". The previous session's diagnosis was wrong — the `pollStackStatus` code was fine, and deploying it changed nothing.

### Investigation

Traced the full progress reporting pipeline:

1. **Lambda logs for `update-server-status`**: Every server ever created only received ONE progress update: `instance_launching`. Steps 3-7 (`instance_running`, `installing_tools`, `tools_installed`, `cloning_repos`, `ready`) never arrived at the API.

2. **DynamoDB state**: The live server was stuck at `status: provisioning`, `provisioningStep: instance_launching` with a valid `elasticIp` and `instanceId` — meaning CloudFormation completed successfully but UserData never finished.

3. **EC2 console output** (`get-console-output`): The smoking gun appeared at the end of the cloud-init log:

```
E: Package 'awscli' has no installation candidate
Failed to run module scripts_user (scripts in /var/lib/cloud/instance/scripts)
```

### Root Cause

Both EC2 templates had `apt-get install -y ... awscli` in UserData (line 178 in on-demand, line 187 in spot). On Ubuntu 24.04 Noble, the `awscli` package is not in the default apt repositories. Combined with `set -e` at the top of the script, the apt failure killed the entire UserData execution.

The script flow was:
1. `report_progress "instance_launching"` — succeeds (called before apt-get)
2. `apt-get update && apt-get upgrade -y` — succeeds
3. `apt-get install -y ... awscli` — **FAILS**, script exits
4. Everything after line 178 never runs: no `rocky` user, no SSH keys, no tools, no further progress reports

This single failure explains both bugs:
- **UI stuck**: Only `instance_launching` ever reached the API
- **SSH denied**: The `rocky` user was never created; the SSH key only existed for the default `ubuntu` user via cloud-init

### Fix

Replaced `awscli` with the official AWS CLI v2 installer in both templates:

```bash
curl -s "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o /tmp/awscliv2.zip
unzip -q /tmp/awscliv2.zip -d /tmp
/tmp/aws/install
rm -rf /tmp/awscliv2.zip /tmp/aws
```

Uploaded both fixed templates to S3. Created a new server — all 7 provisioning steps reported correctly, UI updated in real time, and SSH as `rocky` user worked immediately.

### Lesson Learned

The previous session's "uncommitted pollStackStatus changes" diagnosis was a red herring. The `pollStackStatus` code was already correct (it keeps status as `provisioning` until UserData calls `ready`). The real issue was that UserData never reached the `ready` call because it crashed on apt-get. When debugging "progress updates not arriving," check the EC2 system log (`get-console-output`) before assuming the backend Lambda pipeline is broken — the problem may be that the EC2 never sends the updates in the first place.

Also: never assume apt packages available on Ubuntu 22.04 exist on 24.04. The `awscli` package was removed from Noble's default repos. Use the official AWS installer for reliability across Ubuntu versions.

### Closed Issues

- `rockysurf-ghf` — Provisioning progress updates missing for steps 3-7 (real fix)
- `rockysurf-jdh` — SSH keys not working on provisioned servers (real fix)

---

## 2026-02-05 (continued) - Bug Sweep and Dashboard Polish

### Cleaning Up After the awscli Fix

With servers actually provisioning end-to-end for the first time, a wave of smaller bugs became visible. The SSH command on the server detail page showed `ssh rocky@<ip>` but didn't include the `-i` flag for the generated key file — so users who chose "Generate for me" couldn't actually connect without knowing to add `-i rocky-surf-*.pem` themselves. Quick fix to `ServerDetailPage.tsx` to show `ssh -i {name}.pem rocky@{ip}` when a generated key pair exists.

Beads Viewer was also failing to install on EC2 instances. The templates had `pipx install beads-viewer`, but `bv` is a Go binary distributed via a curl install script, not a Python package. Replaced with the official installer: `curl -fsSL "https://raw.githubusercontent.com/Dicklesworthstone/beads_viewer/main/install.sh" | bash`.

Investigated private repo cloning — turns out createServer.ts never passes `GitHubAppTokenSecretArn` to the CloudFormation template, so EC2 instances have no GitHub credentials. This is a deeper problem: GitHub App installation access tokens are short-lived (1 hour), so even if we passed one at provision time, it would expire. Deferred this to the GitHub Integration epic (`rockysurf-mtu`) which needs a proper design for token generation and refresh.

### The pollStackStatus Race Condition

A more subtle bug emerged: a freshly provisioned server showed "Running" but the Connection section was blank — no IP, no SSH command. DynamoDB had `elasticIp: null` despite CloudFormation having the outputs. Timing analysis of the CloudWatch logs told the story:

- 23:11:29 — pollStackStatus scanned, found server with `status: provisioning`, stack was `CREATE_IN_PROGRESS`
- ~23:12:00 — CloudFormation reached `CREATE_COMPLETE` (between poll cycles)
- 23:12:04 — UserData finished fast, called `report_progress("ready")`, which set `status: running`
- 23:12:29 — Next poll scan looked for `status = provisioning`, found zero matches

The 60-second gap between polls meant `CREATE_COMPLETE` was never observed. By the time the poller ran again, the server was already `running` — and the poller only scanned for `provisioning` servers, so it skipped it entirely, never writing the CloudFormation outputs.

Fix was to broaden the `getServersNeedingUpdate()` scan filter: `#status = :provisioning OR (#status = :running AND attribute_not_exists(elasticIp))`. This catches servers that raced past the poller. Also backfilled the broken server's DynamoDB record directly from CloudFormation outputs as an immediate fix.

### Dashboard Provisioning Indicator

With the bugs fixed, turned to the Frontend Dashboard epic. The dashboard server cards showed a flat "Provisioning" badge but gave no indication of which step the server was on — users had to click into the detail page to see the 7-step timeline. Added a compact step indicator directly on the dashboard card: a small amber bar with the current step label and animated dots (e.g., "Creating infrastructure...", "Installing tools..."). Updates in real-time via WebSocket, disappears cleanly when the server reaches "Running." Tested end-to-end by creating a server and watching the steps progress on the dashboard.

### Closed Issues

- `rockysurf-mc1` — Beads Viewer not installed on EC2
- `rockysurf-hnv` — pollStackStatus race condition (connection info missing)
- `rockysurf-q62` / `rockysurf-l0a` — SSH command consolidated and fixed

---

## 2026-02-05 (evening) - UX Polish and Add Repository Modal

### Error Boundary and Toast Notifications

Replaced all `alert()` calls throughout the frontend with `react-hot-toast` — a small but impactful UX change. Previously, server actions (start, stop, resize, terminate, create) showed browser alert dialogs for success and error feedback. These were jarring and blocked the UI. Toast notifications slide in from the top, auto-dismiss, and feel significantly more polished.

Also wrapped the entire app in an `ErrorBoundary` component that catches unhandled React render errors and shows a dark-themed fallback page with a "Reload" button instead of a white screen of death. This is defensive infrastructure — ideally never seen, but critical when it's needed.

### GitHub App Warning Banner (`rockysurf-5tj`)

The dashboard now shows a dismissible warning banner when the GitHub App isn't installed, with a direct link to the installation page. This solves a discoverability problem: new users would sign in, land on the dashboard, click "Create Server," and only then discover they needed to install the GitHub App. Now the guidance appears immediately. The dismiss state persists in localStorage and resets on logout so returning users aren't nagged, but new sessions start fresh.

### Add Repository Modal (`rockysurf-hij`)

Implemented the frontend modal for adding repositories to existing servers. This was the last piece of the server provisioning feature set — users could already select repos at creation time, but had no way to add more after the fact.

The modal follows the `ResizeServerModal` pattern: separate component file (`AddRepositoryModal.tsx`), triggered via the existing `confirmModal` state machine in `ServerDetailPage`. A "+" button appears next to the "Repositories" heading on any non-terminated server.

On mount, the modal checks GitHub App installation status and fetches authorized repositories, filtering out any already on the server (compared by `htmlUrl`). The remaining repos appear in a scrollable list with radio buttons (single selection since the backend API takes one repo at a time), search filtering, and a repo count indicator. The component reuses all existing CSS classes from `CreateServerPage` — no new visual patterns needed.

Three distinct empty/error states handle edge cases: GitHub App not installed (shows install link), all repos already added (shows manage link), and API errors (inline red text). Browser testing confirmed all states: the repo list with selection, the empty state when all repos are already added, and the inline error display when the API rejects the request (expected for terminated servers with no real infrastructure).

### Closed Issues

- `rockysurf-5tj` — GitHub App not-installed warning banner on dashboard
- `rockysurf-hij` — Add repository modal

---

## 2026-02-05 (late evening) - Cost Summary & EventBridge Migration

### Dashboard Cost Summary

Added a cost summary section to the dashboard that appears above the server grid whenever active servers exist. It shows the total estimated cost across all servers, with a per-server breakdown showing name, size, pricing type (Spot/On-Demand), uptime, and individual cost. The calculation uses the same hourly rates as the server detail page, with a 70% discount for spot instances. The summary disappears cleanly when no servers are running and no costs have accrued.

### Replacing CloudFormation Polling with EventBridge Events (`rockysurf-mc9`)

The biggest architectural change of the day: replacing the 1-minute EventBridge polling rule with native CloudFormation Stack Status Change events. This was the definitive fix for a race condition (`rockysurf-hnv`) where the Elastic IP wasn't written to DynamoDB before the frontend rendered the server detail page.

**The Problem**: `pollStackStatus` ran every 60 seconds, scanning DynamoDB for servers with `status: provisioning` and then checking their CloudFormation stacks. If `CREATE_COMPLETE` happened between polls, the 60-second window meant the frontend could show "Running" (set by UserData's `report_progress("ready")`) before the poller had a chance to write the `elasticIp` from CloudFormation outputs. An earlier fix broadened the scan filter to catch `running` servers missing `elasticIp`, but this was still polling-based — a band-aid over a fundamentally racy design.

**The Fix**: CloudFormation natively emits `CloudFormation Stack Status Change` events to EventBridge when stacks transition states. A new EventBridge rule matches these events for `rocky-surf-server-*` stacks and fires immediately — no 60-second delay, no scan, no race window. The rule targets the same Lambda but with a completely different event shape.

**Handler Rewrite**: The `pollStackStatus` handler was rewritten to accept `EventBridgeEvent<'CloudFormation Stack Status Change', StackStatusDetail>` instead of `ScheduledEvent`. The old flow (scan DynamoDB → iterate servers → check each stack) was replaced with a direct flow: extract stack name and status from the event detail, call `DescribeStacks` to get outputs and tags, look up the server by `ServerId` tag (a primary key lookup, not a scan), then process based on status. The helper functions (`updateServerSuccess`, `updateServerFailed`, `updateServerTerminated`, `getStackFailureReason`) were all reused unchanged.

**Test Rewrite**: The test file was fully rewritten — `createScheduledEvent()` became `createStackEvent()` which builds proper EventBridge event payloads with `stack-id` ARNs and `status-details`. All `ScanCommand` mocks were replaced with `GetCommand` mocks. New test cases were added for: missing `ServerId` tag on stack, server not found in DynamoDB, extracting serverId from tags, and missing ElasticIp output. All 14 tests pass.

**Frontend Belt-and-Suspenders**: As an additional safety measure, both `ServerDetailPage` and `DashboardPage` now call `fetchServer()`/`listServers()` when the WebSocket delivers a `provisioning-progress` message with `step === 'ready'`, instead of doing an inline-only state update. This ensures the frontend always picks up the `elasticIp` from DynamoDB even if the EventBridge handler wrote it slightly before or after the progress message arrived.

**Deployment**: Backend Lambda updated, EventBridge stack deployed (replacing the old polling rule with the event-driven rule), frontend synced to S3, CloudFront cache invalidated.

### Closed Issues

- `rockysurf-mc9` — Elastic IP missing on running server detail page
- `rockysurf-p75` — Rewrite pollStackStatus tests for EventBridge events
- `rockysurf-6h5` — Fix ServerDetailPage to refetch on provisioning ready
- `rockysurf-w0b` — Fix DashboardPage to refetch on provisioning ready
- `rockysurf-0e1` — Deploy backend, EventBridge, and frontend changes

---

## 2026-02-06 - Surge Packs Wired End-to-End & Visual Polish

### Surge Pack Selection Replaces Tool Checkboxes

The biggest user-facing change since launch: server creation now uses **Surge Packs** — curated bundles of tools — instead of individual tool checkboxes. This was a full-stack change touching backend types, Lambda handlers, CloudFormation, the frontend API client, and the Create Server page.

**Backend** (`rockysurf-fc1`): The `createServer` Lambda no longer accepts a raw `tools` array. Instead it takes a `packId`, looks up the surge pack in DynamoDB, validates it exists and is enabled, then resolves the tool list from the pack. The server record stores both `packId` (for display) and the resolved `tools` array (for EC2 provisioning). The `VALID_TOOLS` constant was removed entirely — tool definitions now live in DynamoDB, not in code.

**Frontend** (`rockysurf-sz2`): The Create Server page fetches packs from `GET /surge-packs` on mount and renders them as radio cards. The old `TOOL_OPTIONS` constant and `selectedTools` state were replaced with `surgePacks`, `selectedPackId`, and `loadingPacks`. The `listSurgePacks` Lambda enriches pack data by joining tool IDs with the tools table, so the frontend gets full tool names for display.

**Infrastructure**: Added `SURGE_PACKS_TABLE` env var to `CreateServerFunction` in `lambdas.yaml`. IAM was already sufficient (wildcard `rocky-surf-*` table access).

### Three Surge Packs

Populated the DynamoDB table with three packs, each containing one primary AI agent plus shared base tools (Agent Deck, Beads, Beads Viewer):

- **Claude Code** (`ai-coding-agents`) — Claude Code + base tools
- **Amp** (`amp-agents`) — Amp + base tools (install via `curl -fsSL https://ampcode.com/install.sh | bash`)
- **Codex CLI** (`codex-cli`) — Codex CLI + base tools

### Deployment Lessons (The Hard Way, Again)

The initial deployment worked for CloudFormation and the frontend, but the create-server API returned 400. Root cause: Lambda code was uploaded to `lambdas/servers.zip` but the CloudFormation template references `lambdas/dev/servers.zip`. This mismatch meant Lambdas were still running old code that expected a `tools` array instead of `packId`.

The fix was to use `scripts/deploy-backend.sh --function servers` which handles the correct S3 path and updates all Lambdas in the category. The manual deployment commands in `.claude/CLAUDE.md` were replaced with instructions to always use the deploy script, with a warning that manual uploads caused this outage.

### Surge Pack Card Art

Added custom artwork for each surge pack — square images with distinct color themes (blue for Claude Code, green for Amp, magenta for Codex CLI). The cards render in a 3-column grid with themed border glow on selection: blue `box-shadow` for Claude Code, green for Amp, magenta for Codex CLI. Hover state lifts the card slightly and zooms the image. The effect is noticeably more polished than the plain radio buttons they replaced.

One gotcha: the `SURGE_PACK_IMAGES` mapping in the component initially used `claude-code` and `amp` as keys, but the actual DynamoDB packIds are `ai-coding-agents` and `amp-agents`. Only Codex CLI's image loaded on the first deploy because its packId matched. Fixed by checking the actual packIds from DynamoDB.

### Full Acceptance Testing

All surge packs tested end-to-end: created servers with each pack (Claude Code, Amp, Codex CLI), verified all three provision successfully. Also tested all instance sizes (small/medium/large), both pricing types (on-demand and spot), and both SSH key options (generate and bring-your-own). Everything works.

### Closed Issues

- `rockysurf-fc1` — Update create-server to accept surge pack selection (backend)
- `rockysurf-sz2` — Update frontend to use surge pack selector (frontend)

---

## 2026-02-07 - DB-Driven Tool Installation (No More Hardcoded UserData)

### Epic Complete: `rockysurf-llt`

The single biggest infrastructure improvement since Secrets Manager: EC2 server provisioning no longer hardcodes tool installations in CloudFormation UserData. Adding or modifying a tool is now a single DynamoDB write — no template changes, no redeployment needed.

### The Problem

Both EC2 templates (`ec2-ondemand.yaml` and `ec2-spot.yaml`) had ~150 lines of hardcoded `apt-get install`, `npm install -g`, and `curl | bash` blocks. Every new tool required editing YAML templates, uploading to S3, and potentially breaking the carefully ordered install sequence. The DynamoDB Tools table already existed with `installScript` fields, but these were purely metadata for the frontend — EC2 never read them.

### The Solution

Three new fields on the `Tool` type:
- **`installOrder: number`** — numeric ordering with gaps of 10 for future insertion (0=bootstrap, 10=apt packages, 20=nodejs, 30=npm/curl dependents, 40=agent tools)
- **`bootstrap: boolean`** — `true` means hardcoded in UserData (curl, unzip, jq, aws-cli), skipped by the DDB loop
- **`runAs: 'root' | 'rocky'`** — execution context for the install script

EC2 UserData now has three phases:
1. **Bootstrap** (hardcoded): `apt-get install -y curl unzip jq`, AWS CLI v2 installer, rocky user creation, SSH setup
2. **Dynamic base tools**: `aws dynamodb scan` with filter `category=base AND enabled=true AND bootstrap=false`, sorted by `installOrder`, each script executed via `install_tool()` function that handles root vs rocky context
3. **Dynamic agent tools**: `aws dynamodb get-item` for each tool ID from the surge pack, same `install_tool()` execution

The `install_tool()` function is the key abstraction — it takes a tool ID, runAs context, and script, then runs via `bash -c` (root) or `sudo -u rocky bash -c` (rocky), with `|| echo "WARNING: $tool_id failed"` so one tool failure doesn't abort everything.

### Seed Data

Expanded from 11 tools to 18, adding 7 bootstrap/system tools that were previously only in templates:

| Order | Tools | Category |
|-------|-------|----------|
| 0 | curl, unzip, jq, aws-cli | Bootstrap (hardcoded) |
| 10 | git, tmux, build-essential, python3-pip, python3-venv, pipx | Base (apt) |
| 20 | nodejs | Base (needs curl) |
| 30 | playwright, beads, agent-deck, beads-viewer | Base (need npm/curl) |
| 40 | claude-code, codex, amp | Agent (surge pack) |

Also standardized `pipx` across both templates — it was previously only on spot instances.

### Files Changed

| File | Change |
|------|--------|
| `backend/src/lib/types.ts` | Added `installOrder`, `bootstrap`, `runAs` to Tool interface |
| `scripts/seed-tools.sh` | 18 tools with full metadata |
| `ec2-ondemand.yaml` | `ToolsTableName` param, DynamoDB IAM policy, dynamic UserData |
| `ec2-spot.yaml` | Same + preserved spot-specific EIP association block |
| `createServer.ts` | Passes `ToolsTableName` to CloudFormation |
| `lambdas.yaml` | `TOOLS_TABLE` env var on CreateServerFunction |
| `listTools.ts` | Sort by `installOrder`, omit internal fields from API |

### What This Enables

The real payoff is operational: adding a new tool to every server is now `aws dynamodb put-item` with the right fields. No git commits, no S3 uploads, no CloudFormation deploys. Change a tool's `enabled` flag to `false` to stop installing it. Change `category` from `agent` to `base` to make it install everywhere. This subsumes the earlier `rockysurf-yxu` issue which only covered agent tools — now both base AND agent tools are DB-driven.

### Closed Issues

- `rockysurf-llt` — Epic: Externalize base tools to DynamoDB
- `rockysurf-cjb` — Seed missing base tools into DynamoDB
- `rockysurf-83h` — Add DynamoDB read permissions to EC2 IAM role
- `rockysurf-oog` — Handle bootstrap dependency (AWS CLI before DDB queries)
- `rockysurf-o4y` — Update ec2-ondemand.yaml UserData
- `rockysurf-qdh` — Update ec2-spot.yaml UserData
- `rockysurf-ctj` — Update rockysurf-yxu constraint
- `rockysurf-0y1` — E2E test
- `rockysurf-yxu` — Make EC2 tool installation dynamic (subsumed)

### Created Issues

- `rockysurf-0su` — Epic: Surge Pack Creator (admin CRUD for tools and packs)
- `rockysurf-8u6` — Epic: Customer Defined Tools (users add custom tools)
- `rockysurf-yul` — Epic: Customer Defined Surge Packs (users compose custom bundles)

---

## 2026-02-08 - Dashboard Stop/Start Buttons & First Remote Dev Session

### Stop/Start Buttons on Dashboard Cards (`rockysurf-e91`)

Added action buttons directly to the dashboard server cards, completing the stop server feature end-to-end. The backend Lambda (`stopServer.ts`) and detail page UI already had full stop/start logic — this session wired up the dashboard cards so users can stop/start servers without navigating to the detail page.

**Implementation**: The `ServerCard` component gained `actionLoading` state and two handlers (`handleStop`, `handleStart`) that call the API, update the parent server list via callback, and show toast notifications. Both handlers use `e.preventDefault()` + `e.stopPropagation()` to prevent the card's `<Link>` from navigating when clicking a button. The `canStop`/`canStart` logic mirrors the detail page: buttons only appear for on-demand instances in the appropriate state. Spot instances correctly show no action buttons since AWS ASG-backed spots can't be stopped/started.

CSS was minimal — a `.server-card-actions` flex row with a border-top separator, reusing the existing `.button.secondary.small` and `.button.primary.small` classes.

### First Session on a Rocky Surf Server

This was the first development session running on a Rocky Surf-provisioned EC2 instance rather than the original dev laptop. This surfaced environment gaps:

**Missing AWS credentials**: The `AdministratorAccess-111111111111` SSO profile wasn't configured. Copied `~/.aws/config`, `~/.aws/credentials`, and `~/.aws/sso/cache/` from the dev laptop via SCP. The SCP command for the SSO cache created a nested `cache/cache/` directory — a common gotcha with `scp -r` on directories ending in `/`.

**Headless SSO login**: `aws sso login` requires a browser, which doesn't work on a headless Ubuntu server. The workaround was copying the SSO token cache from a machine with an active session. Both SSO tokens and exported static credentials are time-limited, so there's no durability advantage either way.

**Missing VITE_API_BASE_URL**: The first frontend build defaulted to `http://localhost:3000` because `VITE_API_BASE_URL` wasn't set. The deploy script (`scripts/deploy-frontend.sh`) handles this automatically, but the manual `npm run build` didn't. Sign-in redirected to localhost. Fixed by passing the env var explicitly: `VITE_API_BASE_URL="https://abcd1234ef.execute-api.us-east-1.amazonaws.com/dev/" npm run build`.

**Git identity not configured**: `git commit` failed because `user.name` and `user.email` weren't set on the new machine. Configured per-repo.

### Playwright Verification

Used Playwright (already installed on the server via the surge pack) to verify the dashboard. Injected the auth token into localStorage, navigated to the dashboard, and confirmed: the sole server is a Spot instance showing "Running" with no action buttons — exactly correct behavior. Stop/Start buttons will appear when an on-demand server is created.

### Closed Issues

- `rockysurf-e91` — Stop server (dashboard + detail page buttons, frontend deployed)

---

## 2026-02-08 - Gas Town Surge Pack & The Install Script Gauntlet

### Fourth Surge Pack: Gas Town (`rockysurf-qaj`)

Added Gas Town — steveyegge's multi-agent workspace manager that coordinates multiple Claude Code agents — as a new surge pack. This was the first pack that doesn't contain a single coding agent but rather an orchestrator that sits above them, which meant the pack needed all three existing agents (Claude Code, Amp, Codex) bundled alongside it.

### Frontend: Orange Theme

Gas Town's branding uses warm orange/amber tones, so a new `theme-orange` CSS theme was added to complement the existing blue (Claude Code), green (Amp), and magenta (Codex CLI). The surge pack grid was updated from 3 to 4 columns, and the Gas Town card with its industrial steampunk artwork fits in naturally alongside the other packs.

Files touched: `App.css` (orange hover/selected states), `surgePacks.ts` (image, theme, name constants), and the surge pack image copied to `frontend/public/images/surge-packs/gas-town.png`.

### Three Rounds of Install Script Fixes

Getting `gt` to actually install on EC2 required three iterations — each attempt revealed a different problem:

**Round 1 — Go from source tarball (wrong version):** The initial install script downloaded Go 1.23.6 and ran `go install github.com/steveyegge/gastown/cmd/gt@latest`. This failed silently because Gas Town's `go.mod` requires Go 1.24.2. The version mismatch caused `go install` to error out, but since the install ran during EC2 provisioning, the failure was invisible unless you checked the system log.

**Round 2 — npm package:** Switched to `npm install -g @gastown/gt` since Node.js is already available at install order 20. Simpler than managing a Go toolchain. However, this turned out to not be the recommended approach.

**Round 3 — apt golang-go (correct):** The actual correct installation is straightforward: `sudo apt-get install -y golang-go` (Ubuntu's apt package is sufficient), then `go install github.com/steveyegge/gastown/cmd/gt@latest`, then add `$HOME/go/bin` to PATH. The apt Go package handles the version requirement, and the `go install` puts the binary in the right place.

The lesson: always check the project's actual README for install instructions instead of guessing. The README listed three methods (Homebrew, npm, Go source) and the Go source method with apt-provided Go was the cleanest fit for Ubuntu.

### Multi-Agent Pack Design

The final design decision was making Gas Town a "super pack" that includes all three coding agents. Gas Town is an orchestrator — it needs agents to orchestrate. Rather than forcing users to pick an agent separately, the Gas Town pack installs `gt` plus Claude Code, Amp, and Codex, giving the user (and Gas Town) the full agent toolkit. Each tool still installs via its own `installScript` from DynamoDB, respecting `installOrder` and `runAs`.

### Closed Issues

- `rockysurf-qaj` — Create Gas Town surge pack (tool, pack, image, theme, install script)

---

## 2026-02-08 - Post-Clone Setup Scripts & The `bd` PATH Mystery

### The Problem

Gas Town installs a binary (`gt`) but needs post-install configuration that can only happen *after* repositories are cloned: initializing a workspace, registering each repo as a "rig," and creating crew workspaces. The existing EC2 UserData only had `installScript` which runs during the tool installation phase — before repos exist. A new lifecycle hook was needed.

### setupScript: A New Tool Lifecycle Phase

Added an optional `setupScript` field to the `Tool` type, giving tools a second script that runs after the repo cloning phase. This is a general-purpose mechanism — any tool that needs post-clone configuration can use it — but Gas Town was the first and immediate consumer.

The implementation required solving a variable-passing problem: the setupScript needs to know which repos the user selected, but `install_tool()` runs scripts via `sudo -u rocky bash -c "$script"`, which doesn't forward shell variables from the parent script. The post-clone setup section bypasses `install_tool()` and instead inlines the execution with `REPOS` passed explicitly: `sudo -u rocky bash -c "export REPOS='$REPOS'; $setup_script"`.

Gas Town's setupScript follows the official Gas Town setup flow: `gt install ~/gt --git` to create the workspace, then for each repo URL: extract the name, convert hyphens to underscores (Gas Town doesn't allow hyphens in rig names), register it with `gt rig add`, and create a crew workspace with `gt crew add`. The `gt mayor attach` step was deliberately left out — it's an interactive command that the user needs to run themselves.

### The Invisible Failure

The first deploy appeared to work — no errors in the provisioning UI, server reached "ready" state — but SSH revealed no `~/gt` directory. The setupScript hadn't created anything. With no visible error output, the debugging trail went cold until pulling the EC2 system log via `aws ec2 get-console-output`.

The console log revealed the setupScript *was* executing, but every `gt` command failed with:

```
Error: cannot verify beads version: failed to run bd: exec: "bd": executable file not found in $PATH
```

Gas Town has a hard dependency on beads (`bd`) for version verification. Beads installs its binary to `~/.beads/bin/`, and the beads installScript adds that to `~/.bashrc` — but `~/.bashrc` isn't sourced in the non-interactive `bash -c` context that `install_tool()` uses. The same issue affected `$HOME/go/bin` (where `gt` lives) and `$HOME/.local/bin` (where Claude Code lives).

The fix was straightforward: the setupScript's PATH export now includes all three tool-specific bin directories: `export PATH="$PATH:$HOME/go/bin:$HOME/.beads/bin:$HOME/.local/bin"`. This is a pattern worth remembering — any tool installed via `install_tool()` that modifies `~/.bashrc` for PATH won't have that PATH available to subsequent scripts in the same UserData execution.

### Files Changed

| File | Change |
|------|--------|
| `backend/src/lib/types.ts` | Added optional `setupScript?: string` to Tool interface |
| `scripts/seed-tools.sh` | Added `setupScript` to gas-town with PATH fix, rig/crew creation |
| `infrastructure/templates/ec2-ondemand.yaml` | Post-clone setup phase with REPOS env var passing |
| `infrastructure/templates/ec2-spot.yaml` | Same post-clone setup phase |

### Closed Issues

- `rockysurf-9h1` — Fix Gas Town setupScript: use gt rig add for repo cloning and create crew workspace
- `rockysurf-4id` — Fix gt mayor attach failure (removed from setupScript — user-interactive command)

---

## 2026-02-08 (continued) - Admin CRUD, Image Uploads & Surge Pack Branding

### Epic Complete: `rockysurf-0su` (Surge Pack Creator)

Closed out the entire Surge Pack Creator epic in a single marathon session — admin backend, admin frontend, image upload infrastructure, and surge pack branding. This was the most breadth-intensive session yet, touching CloudFormation, Lambda handlers, API Gateway, S3, EventBridge, and the React frontend in a coordinated sweep.

### Admin Backend (`rockysurf-75s`, `rockysurf-obi`)

Eight CRUD Lambda handlers for managing tools and surge packs: `listAdminTools`, `getAdminTool`, `createTool`, `updateTool`, `listAdminSurgePacks`, `getAdminSurgePack`, `createSurgePack`, `updateSurgePack`. Each handler checks `isAdmin` on the user record before proceeding — the admin check was added as a reusable `requireAdmin()` helper in `lib/auth.ts`.

API Gateway got a new `/admin` resource tree with `/admin/tools`, `/admin/tools/{toolId}`, `/admin/surge-packs`, `/admin/surge-packs/{packId}` — all with POST/GET/PUT/OPTIONS methods. The `lambdas.yaml` template grew significantly with 8 new Lambda function definitions, but the pattern was mechanical: each handler follows the same auth → admin check → DynamoDB operation → response structure.

A new `admin` category was added to the deploy script to handle the admin Lambda zip separately from the existing `servers`, `auth`, `github`, `websocket`, `surge-packs`, and `tools` categories.

### Admin Frontend (`rockysurf-5yp`, `rockysurf-9lw`, `rockysurf-ik4`, `rockysurf-4tk`)

Built an admin section accessible via an "Admin" link in the dashboard header (visible only to admin users). The admin UI has two tabs: Tools and Surge Packs, each with a table view and modal forms for create/edit.

The Tools table shows name, category, install order, enabled/disabled toggle, and bootstrap flag. The Surge Packs table shows name, associated tools, display order, enabled status, and a thumbnail preview. Both tables support inline enable/disable toggling without opening the edit modal.

Three P3 stretch goals were also completed: a Preview Server Install panel that renders the full tool installation sequence for a surge pack (showing install scripts grouped by phase with runAs context), drag-and-drop reordering via `@dnd-kit` for both tables, and CodeMirror 6 integration for syntax-highlighted script editing in the tool form modals. The CodeMirror editor uses a dark theme matching the app's color scheme and handles bash syntax highlighting.

### Image Upload Infrastructure (`rockysurf-8g9` through `rockysurf-f28`)

Surge pack cards needed custom artwork, which meant building a proper image upload pipeline. Rather than accepting base64 blobs through the API, the architecture uses S3 presigned URLs — the frontend gets a signed upload URL, PUTs the file directly to S3, and an EventBridge rule triggers a processing Lambda.

**S3 Uploads Bucket** (`rockysurf-8g9`): New `rocky-surf-uploads-staging-dev` bucket with CORS configuration for PUT requests from the CloudFront domain. A 24-hour lifecycle rule auto-deletes staging files. EventBridge notifications enabled for `s3:ObjectCreated:*` events.

**Upload Service** (`rockysurf-dlb`): Two Lambdas — `requestUploadUrl` generates a presigned PUT URL scoped to a specific context (e.g., `surge-pack-images/`), and `processUpload` triggers on EventBridge when a file lands in S3, copies it from staging to the final location in the frontend bucket, and updates the relevant DynamoDB record with the permanent URL.

The upload context system is extensible: `contexts.ts` defines a `ContextHandler` interface with `validate()`, `generateKey()`, and `onProcessed()` methods. The `SurgePackImageContext` handler validates that the pack exists and the user is admin, generates a unique S3 key with timestamp, and updates the pack's `imageUrl` field after processing.

**Presigned URL Gotcha**: The initial implementation generated presigned URLs without `Content-Length` constraints, which worked in testing but would allow arbitrarily large uploads. Added `contentLength` to the presigned URL generation and `BatchGetItem` permission to the Lambda role (needed for the context handler to validate pack + tool existence in a single call).

### Surge Pack Branding (`rockysurf-cmz`)

Added `imageUrl` and `theme` fields to the `SurgePack` model. The frontend maps `packId` to a static image path via `SURGE_PACK_IMAGES` in `surgePacks.ts`, with a fallback to `imageUrl` from the API for dynamically uploaded images. Dashboard server cards show a small pack icon next to the server name, and the server detail page shows it in the pack info section. Each pack's CSS theme (blue, green, magenta, orange) drives the selection glow and hover effects on the create server page.

### Closed Issues

- `rockysurf-0su` — Epic: Surge Pack Creator
- `rockysurf-75s` — Admin backend: auth helper, 8 CRUD Lambda handlers
- `rockysurf-obi` — Admin infra: API Gateway resources + Lambda CloudFormation
- `rockysurf-5yp` — Admin frontend: table UI + form modals
- `rockysurf-9lw` — Admin UI: Preview Server Install panel
- `rockysurf-ik4` — Admin UI: drag-and-drop reordering
- `rockysurf-4tk` — Admin UI: CodeMirror script editor
- `rockysurf-8g9` — S3 uploads staging bucket
- `rockysurf-h91` — API Gateway /uploads endpoint
- `rockysurf-dlb` — Generalized upload service (Lambda handlers + contexts)
- `rockysurf-suq` — EventBridge rule for upload processing
- `rockysurf-sya` — Deploy script and frontend updates
- `rockysurf-odo` — Clean up old upload resources
- `rockysurf-f28` — Deploy and verify upload refactor
- `rockysurf-cmz` — Add imageUrl/theme to SurgePack model

---

## 2026-02-09 - Dashboard Activity Feed

### Feature: Activity Feed (`rockysurf-b3d`)

Added a chronological activity feed to the dashboard showing the 10 most recent server lifecycle events — created, started, stopped, and terminated. The feed sits below the server grid and gives users an at-a-glance timeline of what's been happening across their infrastructure.

**Backend**: The `listServers` API already stored `startedAt`, `stoppedAt`, and `terminatedAt` timestamps on Server records in DynamoDB, but the `toServerSummary()` mapping stripped them out. Added all three optional timestamp fields to the `ServerSummary` interface in both `backend/src/lib/types.ts` and the frontend's `api.ts`, and included them in the summary mapping. No new DynamoDB queries or tables needed — the activity data was already being stored, just not exposed.

**Frontend**: Created an `ActivityFeed` component (`frontend/src/components/ActivityFeed.tsx`) that derives events from the server timestamp fields. Each server can produce up to 4 events (created + started + stopped + terminated), all pushed into a single array, sorted by timestamp descending, and sliced to the top 10. A `relativeTime()` helper formats timestamps as "2h ago", "3d ago", etc. without adding a dependency — just simple arithmetic on the time difference.

Each event type has a distinct icon and color: blue `+` for Created, green play triangle for Started, grey square for Stopped, red `x` for Terminated. The component returns `null` when there are no events, so the dashboard stays clean for new users with no servers yet.

**Styling**: Dark-themed `.activity-feed` panel matching the existing cost summary and server card aesthetic — `#161b22` background, `#30363d` borders, `#21262d` row separators. Server names render in the link-blue (`#58a6ff`) used throughout the app.

**Testing**: Updated the `listServers.test.ts` assertion to include the three new timestamp fields. All 10 tests pass. Backend deployed via `deploy-backend.sh --function servers`, frontend built and synced to S3 with CloudFront cache invalidation.

### Bug Found: Surge Pack Images Missing (`rockysurf-e5o`)

After deploying the activity feed, noticed the surge pack icon is no longer appearing on dashboard server cards or the server detail page. The `SURGE_PACK_IMAGES` static mapping in `surgePacks.ts` should render the pack thumbnail next to the server name, but it's blank. Filed as `rockysurf-e5o` (P2 bug) linked to `rockysurf-cmz` (the feature that introduced `imageUrl`/`theme`). Likely a regression from the image upload refactor — the static mapping may have been disrupted when the dynamic `imageUrl` path was introduced.

### Closed Issues

- `rockysurf-b3d` — Add activity feed to dashboard

### Created Issues

- `rockysurf-e5o` — Bug: Surge pack image missing on dashboard card and server detail page

---

## 2026-02-09 - Surge Pack Display Data: From Frontend Hack to Backend Enrichment

### The Bug and the Quick Fix (`rockysurf-e5o`)

After deploying the activity feed, the surge pack icon disappeared from dashboard cards and the server detail page. Investigation revealed the root cause: when the "Open Code" pack was added via the admin UI, it got an `imageUrl` stored in DynamoDB, but the dashboard and detail pages were still reading from the hardcoded `SURGE_PACK_IMAGES` map in `surgePacks.ts` — a map that didn't include the new pack.

The initial fix was a `useSurgePacks` hook that fetched packs from the `/surge-packs` API at mount time, merging dynamic `imageUrl` values with the static fallback map. It worked, but introduced an extra API call on every page load and kept two sources of truth (DynamoDB + static map) for the same data.

### The Refactor (`rockysurf-cjd`)

After questioning whether the hook approach was really the right design, the decision was to move pack display data resolution to the backend. The server API already knows each server's `packId` — it should resolve the display name and image URL before sending the response, rather than making the frontend do a separate lookup.

**Backend**: Added `packImageUrl` and `packName` to the `ServerSummary` type. In `listServers`, after querying servers, the handler collects all distinct `packId` values and does a single `BatchGetItem` on the SurgePacks table. Each summary then gets its `packImageUrl` and `packName` populated from the lookup. In `getServer`, a simple `GetItem` fetches the pack data for the single server. Both handlers wrap the pack lookup in a try-catch so a SurgePacks table failure degrades gracefully — servers still load, just without pack branding.

**Infrastructure**: Added `SURGE_PACKS_TABLE` environment variable to both `ListServersFunction` and `GetServerFunction` in `lambdas.yaml`. The table name was already in `db.ts` via `Tables.SurgePacks`, but the Lambda functions didn't have the env var to override the default.

**Frontend**: Removed the `useSurgePacks` hook entirely. Dashboard and detail pages now read `server.packImageUrl` and `server.packName` directly from the API response — no extra fetch, no static mapping needed for display. Cleaned up `SURGE_PACK_NAMES` from `surgePacks.ts` (only the hook used it). Kept `SURGE_PACK_IMAGES` and `SURGE_PACK_THEMES` since the CreateServerPage and admin pages still use them as fallbacks during pack selection.

**Testing**: The `listServers.test.ts` mock for `BatchGetCommand` required using `Tables.SurgePacks` (the runtime value) as the response key, not `process.env.SURGE_PACKS_TABLE`. The test setup in `setup.ts` sets env vars, but `db.ts` evaluates `Tables.SurgePacks` at import time, and module caching means the handler's import resolves before the test setup runs. Lesson: always use the actual `Tables.*` constant for mock response keys, not the env var.

### The Second Bug (`rockysurf-mo5`)

After deploying the refactor, icons appeared for Open Code (which had `imageUrl` in DynamoDB from the admin upload) but not for the original 4 packs (AMP, Claude Code, Codex CLI, Gas Town). The old static `SURGE_PACK_IMAGES` fallback had been removed, but the DynamoDB records for the original packs never had `imageUrl` populated — they'd always relied on the static mapping.

Fix was a data-only change: four `UpdateItem` calls to set `imageUrl` in the SurgePacks DynamoDB table for the original packs, pointing to their existing image paths in S3 (`/images/surge-packs/amp.png`, etc.). No code changes, no redeployment. Verified in the browser that both AMP and Open Code servers show their icons on both the dashboard and detail pages.

### Key Takeaway

This was a textbook example of a regression chain: the admin image upload feature (`rockysurf-cmz`) added `imageUrl` to DynamoDB but only for new packs. The quick frontend fix (hook) papered over the real problem. The backend refactor was the right architecture, but exposed the data gap that the static mapping had been hiding. The actual fix was 4 DynamoDB writes. Sometimes the right solution is fixing the data, not the code.

### Closed Issues

- `rockysurf-e5o` — Surge pack image missing (initial frontend fix)
- `rockysurf-cjd` — Epic: Enrich server responses with surge pack display data
- `rockysurf-8gb` — Add packImageUrl/packName to types
- `rockysurf-ht9` — Enrich listServers with pack data
- `rockysurf-bhb` — Enrich getServer with pack data
- `rockysurf-5hw` — Update tests for pack enrichment
- `rockysurf-v3m` — Update frontend to use server-provided pack data
- `rockysurf-gb2` — Deploy backend and frontend
- `rockysurf-mo5` — Bug: Original 4 packs missing imageUrl in DynamoDB

### References

- Plan: `.claude/plans/refactored-skipping-ember.md`
- Commits: `38dcd26`, `cf38549`, `dc7eeb2`

---

## 2026-02-09 (pm) - Dashboard Terminate Button & Server Branding Epic

### Dashboard Server Card Improvements

Added Terminate button to dashboard server cards alongside the existing Start/Stop buttons. Destructive actions (Stop, Terminate) now require confirmation via a modal dialog before executing. Start remains immediate since it's non-destructive. Button visibility follows a state matrix: running servers show Stop + Terminate, stopped servers show Start + Terminate, provisioning/terminated/failed show nothing. Spot instances can't Start/Stop but can always Terminate.

Extracted `ConfirmModal` from `ServerDetailPage` into a shared component at `frontend/src/components/ConfirmModal.tsx` to avoid duplication. Dashboard modals are rendered via `createPortal` to `document.body` to avoid invalid button-inside-anchor nesting.

### Server Branding Epic

Completed the full branding epic (`rockysurf-xgu`) — when users SSH into a Rocky Surf server, they now see a branded experience instead of default Ubuntu noise.

**What was built:**

1. **ASCII art logo** — Rocky Surf banner rendered in standard 80-column terminals, stored at `infrastructure/branding/logo.txt` and uploaded to S3 at `s3://rocky-surf-deployments-us-east-1/branding/`

2. **Dynamic MOTD generator** (`infrastructure/branding/motd-generator.sh`) — Installed to `/etc/update-motd.d/10-rocky-surf`, runs on each SSH login. Displays the ASCII logo, server name, surge pack name, elastic IP, uptime, and quick-start tips. Reads dynamic data from `/etc/rocky-surf/server-info` written during provisioning.

3. **Custom PS1 prompt** (`infrastructure/branding/rocky-prompt.sh`) — Installed to `/etc/profile.d/`, applies only to the `rocky` user. Shows `rocky@server-name:path$` in teal.

4. **EC2 UserData integration** — Both `ec2-ondemand.yaml` and `ec2-spot.yaml` templates updated with a branding section that: pulls assets from S3, writes server-info with CloudFormation parameters (ServerName, PackName, ElasticIP), disables all default Ubuntu MOTD scripts (system info, ESM ads, legal notices), and sets correct permissions. Added `BrandingAssetsRead` IAM policy granting `s3:GetObject` on the branding prefix.

5. **PackName parameter** — Added `PackName` CloudFormation parameter to both EC2 templates. `createServer` Lambda now passes `pack.name` from DynamoDB so the MOTD shows the surge pack name (e.g., "Gas Town", "Claude Code") instead of raw tool IDs.

**Key decisions:**
- Reused existing deployments S3 bucket with `branding/` prefix rather than creating a new bucket
- All S3 pulls are non-fatal (`|| echo "WARNING: ..."`) so branding failure never blocks provisioning
- Used `echo` statements instead of heredoc for server-info to avoid YAML indentation leaking into file content

### Beads Closed

- `rockysurf-71j` — Add server state buttons to dashboard cards
- `rockysurf-qx9m` — Dashboard card missing Terminate button (deploy fix)
- `rockysurf-xgu` — Epic: Add Rocky Surf branding to all servers
- `rockysurf-3j0` — Design Rocky Surf ASCII art logo
- `rockysurf-bac` — Create S3 bucket/path for branding assets
- `rockysurf-uy2` — Build dynamic MOTD generator script
- `rockysurf-920` — Customize bash prompt (PS1) with Rocky Surf branding
- `rockysurf-ar7` — Update EC2 UserData to pull and apply branding from S3
- `rockysurf-ax7` — Test server branding end-to-end

---

## 2026-02-10 - OpenClaw SurgePack: First GUI Desktop Environment

This was the first SurgePack that required a full graphical desktop rather than just a terminal. OpenClaw is a personal AI assistant that needs a browser and GUI, so the implementation introduced an entirely new dimension to server provisioning: remote desktop access via XRDP.

### The Build

The feature (GitHub #13) was decomposed into 9 tasks under epic `rockysurf-pn9p`, organized in a dependency chain so work could proceed in parallel batches.

**New tools created:**
- `desktop-environment` (base tool, order 35) — Installs XFCE4, XRDP, and Firefox. Runs as root. Made this a reusable base tool rather than bundling it into the OpenClaw-specific tool, so future GUI packs can reuse it.
- `open-claw` (agent tool, order 50) — Installs OpenClaw via npm, runs `openclaw onboard --install-daemon` as the rocky user post-clone.

**RDP password flow:** Users enter an RDP password during server creation. The password is stored in AWS Secrets Manager as a server-scoped secret (`rocky-surf-rdp-password-srv-{id}`), the ARN is passed to the CloudFormation template, and the EC2 UserData fetches it with `aws secretsmanager get-secret-value` and sets it via `chpasswd`. On terminate, the secret is cleaned up. Unlike the GitHub token secret (which fails gracefully), RDP secret failure returns a hard 500 — you can't have a GUI server without a password.

**Frontend changes:** Added a conditional RDP password field on the Create Server page (hardcoded `packId === 'open-claw'` check for now), SSH tunnel instructions on the server detail page, and purple branding for the pack card.

### Post-Deployment Bug Gauntlet

Deploying was the easy part. Testing on real infrastructure surfaced a cascade of issues that don't show up in unit tests:

**1. OpenClaw not installed (EACCES).** The `open-claw` tool had `runAs: "rocky"` (needed for the setupScript daemon install), but `npm install -g` writes to `/usr/lib/node_modules` which requires root. The `install_tool` function runs `sudo -u rocky bash -c "$script"`, so npm tried to write as rocky and got permission denied. Fix: prefix the installScript with `sudo` — rocky has NOPASSWD sudo, so `sudo npm install -g openclaw@latest` works, while the setupScript still runs as rocky.

**2. Firefox "cannot open display" (snap vs XRDP).** Ubuntu 24.04's `apt-get install firefox` installs a snap transitional package. Snap Firefox has known X11 authorization issues with XRDP sessions — it can't connect to the display even from within the desktop. Fix: install Firefox from Mozilla's official APT repository (deb package) instead. This required adding the Mozilla signing key, APT source, and a pin-priority file to prefer the deb over the snap.

**3. Frontend not deployed.** The new code was pushed to git but not deployed to S3/CloudFront, so the live site was still serving old JavaScript. All three user-reported bugs (wrong tools shown, missing pack image, missing RDP instructions) were actually the same root cause. Lesson reinforced: always deploy after pushing.

**4. Firefox not on the desktop.** Installed but invisible — no XFCE desktop shortcut. Added a step to copy `firefox.desktop` to `~/Desktop`.

**5. Firefox showing onboarding wizard.** Even with the homepage correctly configured via enterprise `policies.json`, Firefox's first-run wizard and default new-tab page intercepted the user. Added `OverrideFirstRunPage`, `OverridePostUpdatePage`, `NoDefaultBookmarks`, and `UserMessaging.SkipOnboarding` policies to suppress all of it.

### Desktop Polish

After the bugs were squashed, polished the desktop experience:

- **Getting started doc** — `OpenClaw_Getting_Started.txt` placed on the desktop with a link to docs.openclaw.ai
- **Branded wallpaper** — Created a 1920x1080 wallpaper (OpenClaw logo centered on dark `#121218` background) using PIL, uploaded to S3, downloaded during provisioning and set as XFCE wallpaper via pre-written `xfce4-desktop.xml` config
- **Firefox homepage** — Set to `openclaw.ai` via enterprise policies at `/usr/lib/firefox/distribution/policies.json`

All desktop customization lives in the `open-claw` tool's setupScript rather than the shared `desktop-environment` tool, keeping pack-specific branding isolated.

### Debugging Without Logs

One frustrating aspect: the EC2 console output buffer (64KB) was completely filled by XFCE's 660+ package installations during `apt-get install`. All of our custom provisioning log messages — including the agent tool installation output that would have shown the EACCES error — were pushed out of the buffer. Had to use SSM `send-command` to check `/var/log/cloud-init-output.log` on the running instance to find the actual error. Something to address later — maybe redirect provisioning logs to CloudWatch or a file that survives buffer overflow.

### Key Architectural Decision

Making `desktop-environment` a reusable base tool (not bundled into OpenClaw) means any future GUI pack — say a pack for Cursor, VS Code remote, or another browser-based AI tool — gets XFCE+XRDP+Firefox for free by including `desktop-environment` in its tools list. The pack-specific branding (wallpaper, homepage, desktop files) stays in each pack's own setupScript.

### Beads Closed

- `rockysurf-pn9p` — Epic: OpenClaw SurgePack (GitHub #13) — 9 implementation subtasks
- `rockysurf-rcj8` — Fix OpenClaw npm install EACCES permission error
- `rockysurf-z1xl` — Fix Firefox snap/XRDP X11 authorization error
- `rockysurf-lv6z` — Add Firefox desktop shortcut to XFCE desktop
- `rockysurf-azy8` — Add OpenClaw getting started doc to desktop
- `rockysurf-hlm9` — Add OpenClaw branded wallpaper to XFCE desktop

---

## 2026-02-10 - Fixing Spot Instance Provisioning Failures

The OpenClaw SurgePack launch exposed a nasty Spot instance reliability problem. On-Demand servers provisioned perfectly, but Spot instances were intermittently failing — some would get stuck in `provisioning` forever, others would partially provision with broken tool installations. Investigation revealed three distinct failure modes, each requiring a different fix.

### The REGION Variable Problem

The Spot template (`ec2-spot.yaml`) was fetching `REGION` from the EC2 instance metadata service via `curl`. This worked most of the time, but if the metadata service was slow or unavailable during the brief window after instance launch, the curl would fail — and since `set -e` was active, it would kill the entire UserData script silently. Every downstream AWS CLI call (DynamoDB tool lookups, Secrets Manager fetches, S3 branding downloads) depended on `$REGION`, so a single metadata hiccup cascaded into a completely broken server.

The On-Demand template had already been using `${AWS::Region}` — a CloudFormation intrinsic substitution that gets baked into the script at deploy time, no runtime dependency at all. The fix was a one-line change to match. The TOKEN and INSTANCE_ID metadata fetches were kept since they genuinely need runtime values (they're different per instance), but REGION is constant per deployment.

### The Missing Instance ID

Spot instances use an Auto Scaling Group (ASG) rather than a direct EC2 instance, which means CloudFormation can't provide an `InstanceId` output — the ASG manages the instance lifecycle, and the instance might not even exist when the stack completes. So the `pollStackStatus` Lambda was writing `instanceId: 'pending'` to DynamoDB and it never got updated.

The fix was to have the EC2 instance report its own ID. Modified `report_progress()` in the Spot template to accept optional extra JSON fields, then included `instanceId` in the `instance_running` progress call (the earliest point after the metadata fetch). On the Lambda side, `updateServerStatus.ts` now accepts an optional `instanceId` field and persists it to DynamoDB alongside the provisioning step. The WebSocket broadcast also forwards it so the frontend can show the real instance ID immediately.

### The Stuck Server Problem

The most user-visible failure: Spot instances that never launch at all. When AWS doesn't have Spot capacity for the requested instance type in the target AZ, the ASG creates but no instance materializes. UserData never runs, so no progress callbacks happen, and the server sits in `provisioning` indefinitely.

Built a new `checkProvisioningTimeout` Lambda that runs on a 5-minute EventBridge schedule. It scans the Servers table for any server that's been in `provisioning` status for more than 30 minutes, then for each stuck server: marks it `failed` with a timeout error message, deletes the CloudFormation stack (cleaning up the ASG, EIP, security group, etc.), deletes any Secrets Manager secrets (GitHub token, RDP password), and broadcasts the failure to the user via WebSocket so their dashboard updates immediately.

The Lambda follows the same patterns as `terminateServer.ts` for cleanup and `pollStackStatus.ts` for the DynamoDB/WebSocket flow. Added it to the `servers` deploy category in `deploy-backend.sh` alongside fixing a missing entry for `update-server-status` that had been deploying via CloudFormation but wasn't in the script's function list.

### Infrastructure Changes

- `lambdas.yaml` — New `CheckProvisioningTimeoutFunction` (120s timeout, same IAM role, servers.zip package)
- `eventbridge.yaml` — New `ProvisioningTimeoutRule` with `rate(5 minutes)` schedule expression + Lambda invoke permission
- Deploy sequence: lambdas stack first (creates the function), then eventbridge stack (references the function ARN), then ec2-spot.yaml to S3, then `deploy-backend.sh --function servers`

### Beads Closed

- `rockysurf-ry2u` — Spot instance provisioning failures (P1 bug, was blocking OpenClaw epic)

---

## 2026-02-10 - OpenClaw UX Polish and Infrastructure Deploy Script

Two smaller wins to close out the day. First, hid the GitHub repository selection from the server creation flow when OpenClaw is the selected pack. OpenClaw doesn't need repos — it's a standalone GUI tool — but the form was still showing the full repo picker, GitHub App install prompt, and requiring at least one repo to be selected before submitting. Added a `requiresRepos` flag (mirroring the existing `requiresRdp` pattern) that conditionally renders the Repositories section and skips the validation. The backend already treated `repositories` as optional, so this was frontend-only.

Second — and more significant architecturally — replaced the long-standing "master CloudFormation stack" task (`rockysurf-8a4`, open since day 1) with a deploy script instead. The original plan was a nested CFN stack that deploys all infrastructure in one command, but nested stacks have real downsides: a failure in any child stack rolls back everything, you can't deploy stacks independently for quick iteration, and debugging nested rollbacks is painful.

The new `scripts/deploy-infrastructure.sh` deploys all 8 stacks in dependency order with automatic parameter wiring. The interesting part is the eventbridge stack — it needs Lambda ARNs from the lambdas stack, so the script calls `aws cloudformation describe-stacks` to extract those outputs and passes them as parameters. Templates over 51KB (like lambdas.yaml at 83KB) automatically get the `--s3-bucket` flag.

Hit a bash compatibility issue during development: the initial version used `declare -A` (associative arrays), which requires bash 4+. macOS ships bash 3.2 due to GPL licensing. Rewrote to use `case` statements for the key-value lookups instead — slightly more verbose but works everywhere.

The script supports three modes: full deploy (all 8 stacks), `--from <stack>` (deploy from a specific stack onward), and `--only <stack>` (single stack). This covers the common cases: fresh environment setup, targeted updates after changing one template, and partial redeploys when you know only downstream stacks are affected.

### Beads Closed

- `rockysurf-mlfu` — Remove GitHub repo selection from OpenClaw server creation flow
- `rockysurf-pn9p` — OpenClaw SurgePack epic (all subtasks complete)
- `rockysurf-7yr` — S3 + CloudFront template (was already done, never closed)
- `rockysurf-8a4` — Master infrastructure deployment (reimplemented as shell script)

---

## 2026-02-10 - Removing Elastic IP Dependency (GitHub Issue #11)

Rocky Surf was originally designed with Elastic IPs (EIPs) to provide stable IP addresses, especially for Spot instances that could be replaced. The assumption was that a static IP would give users a clean UX even when underlying instances changed. However, AWS limits each account to 5 EIPs by default, and requesting a limit increase can take days. This artificial ceiling would block scaling beyond 5 concurrent servers — unacceptable for a multi-user platform.

The solution: accept that IPs will change (especially for Spot instances during replacement) and make those changes highly visible in the UI rather than trying to hide them with infrastructure complexity.

### Backend Changes

**Infrastructure — Removed All EIP Resources:**

Modified both CloudFormation templates to remove Elastic IP dependencies:
- `infrastructure/templates/ec2-ondemand.yaml` — Deleted `ElasticIP` resource, `EIPAssociation` resource, and EIP-related IAM policies. Changed stack output from `ElasticIp` (using `!Ref ElasticIP`) to `PublicIp` (using `!GetAtt Instance.PublicIp`). Updated UserData to write `ROCKY_PUBLIC_IP` from instance metadata instead of CloudFormation parameters.
- `infrastructure/templates/ec2-spot.yaml` — Deleted `ElasticIP` resource and the AWS CLI EIP association commands in UserData. Updated to fetch public IP from instance metadata using IMDSv2 token.

Removed EIPs from both instance types (not just Spot) to maintain architectural consistency. All servers now use ephemeral public IPs assigned by AWS.

**Data Model — IP Change Tracking:**

Updated the `Server` and `ServerSummary` interfaces in `backend/src/lib/types.ts`:
- Replaced `elasticIp` and `eipAllocationId` fields with `publicIp`
- Added `previousIp` to track the last known IP address
- Added `ipChangedAt` to store ISO timestamp when IP last changed
- Added `ipChangedRecently` flag to `ServerSummary` (true if changed within last 24 hours)

**Lambda Functions — Detection and Notification:**

Modified three Lambda functions to implement IP change tracking:

1. **pollStackStatus.ts** — Changed to fetch `PublicIp` output instead of `ElasticIp` from CloudFormation stacks. Updated `updateServerSuccess()` to store the public IP in DynamoDB.

2. **listServers.ts** — Added logic to calculate `ipChangedRecently` by comparing `ipChangedAt` timestamp to current time (24-hour window). Included `previousIp` and `ipChangedAt` in the `ServerSummary` response.

3. **updateServerStatus.ts** — Added IP change detection logic. When the EC2 instance reports a new `publicIp` that differs from the stored value, the Lambda:
   - Updates DynamoDB with `publicIp`, `previousIp`, and `ipChangedAt`
   - Broadcasts an `ip-changed` WebSocket message to the user with both IPs and timestamp

Added new WebSocket message type `IpChangedMessage` to `frontend/src/lib/websocket.ts`.

### Frontend Changes

**IP Change Alert Component:**

Created `frontend/src/components/IpChangeAlert.tsx` — a dismissible banner component that displays IP changes prominently. Key features:
- Visual styling: old IP shown in red with strikethrough, new IP in green
- Dismissible per server+timestamp using localStorage (`rocky-surf-alert-dismissed-{serverId}-{timestamp}`)
- Warning icon and clear messaging: "IP Address Changed: 1.2.3.4 → 5.6.7.8"
- CSS classes added to `App.css` for consistent styling

**Dashboard and Detail Page Integration:**

Updated both `DashboardPage.tsx` and `ServerDetailPage.tsx`:
- Changed all "Elastic IP" labels to "Public IP"
- Replaced `elasticIp` references with `publicIp`
- Integrated `IpChangeAlert` component to show when `ipChangedRecently` is true
- Updated WebSocket hook (`useServerUpdates.ts`) to handle `ip-changed` messages and show toast notifications

**Type Updates:**

Updated frontend type definitions in `api.ts` and `websocket.ts` to match backend changes.

### Deployment and Testing

Initial deployment revealed a critical issue: the GitHub OAuth redirect URL was pointing to `localhost` instead of the API Gateway. Investigation found that the worktree at `/Users/johndamask/code/rockysurf-issue-11` didn't have the `.env.local` file, so when the frontend was built with `npm run build`, Vite couldn't find `VITE_API_BASE_URL` and fell back to the hardcoded localhost default in `AuthContext.tsx`.

**Root cause:** Git worktrees don't inherit local config files like `.env.local` (correctly — these are gitignored and should never be committed).

**Fix:** Copied `.env.local` from main repo to worktree, rebuilt frontend with correct environment variables, redeployed to S3, invalidated CloudFront cache.

**Verification:** Tested with Playwright — OAuth flow now correctly redirects to `https://abcd1234ef.execute-api.us-east-1.amazonaws.com/dev/auth/github/callback` (API Gateway URL, not localhost). App loads cleanly with no "Elastic IP" text remaining in source.

### Key Architectural Decision

The dismissible alert approach (with localStorage persistence) prevents alert fatigue while still ensuring users see IP changes. The 24-hour window for "recent" changes balances visibility (users working actively will see the alert) against noise (stale alerts don't linger forever).

Making IP changes a first-class concern with dedicated WebSocket messages and persistent tracking means future features (like SSH config file updates or automated reconnection) can build on this infrastructure.

### Lessons Learned

- Git worktrees don't inherit local config files — must be copied manually for builds
- Always verify deployments by actually testing, not assuming they worked
- Vite requires `.env.local` in the build directory to pick up `VITE_*` environment variables
- CloudFront cache invalidation takes ~10 minutes to propagate
- When debugging OAuth issues, check environment variables first before assuming GitHub App misconfiguration

### Beads/Issues Closed

- GitHub Issue #11 — Architecture change: remove dependency on Elastic IPs
- 7 beads tasks for backend types, CloudFormation templates, Lambda functions, frontend types, IpChangeAlert component, WebSocket handler, and page updates

---

## 2026-02-11 to 2026-02-12 - Spot Instance Interruption Handling (Epic rockysurf-mrt2)

### Summary

Built the full spot instance interruption detection, notification, and recovery system — from EventBridge event capture through real-time frontend countdown banners to automatic server replacement. This was the largest feature epic so far: 17 subtasks across backend, frontend, infrastructure, and testing.

### The Problem

Rocky Surf provisions EC2 Spot instances to save costs, but AWS can reclaim them with just 2 minutes notice. Without interruption handling, users would lose their work with no warning and no easy way to get back to where they were.

### Architecture

The system follows an event-driven pipeline: AWS EventBridge captures the `EC2 Spot Instance Interruption Warning` event and routes it to a `handleSpotInterruption` Lambda. The Lambda finds the affected server by scanning DynamoDB for matching `instanceId`, records the warning, then automatically creates a replacement server (cloning the original's configuration — size, tools, surge pack, repositories, SSH keys). Finally, it broadcasts a WebSocket message to the user's browser, which renders a red countdown banner with a live MM:SS timer.

The auto-replacement is the default behavior (`autoReplaceOnInterruption` defaults to true). When it fires, the banner shows a calmer blue "Replacement server launching automatically" message with a link to the new server. Users who prefer manual control can disable auto-replace, in which case the banner shows a red urgent countdown with a "Launch Replacement Now" button.

### Implementation Journey

**Phase 1 — Backend foundation (Feb 11):** Extended the `Server` type with interruption tracking fields (`spotInterruptionWarningAt`, `spotInterruptionAction`, `spotInterruptionHistory`, `spotReplacementServerId`, `autoReplaceOnInterruption`). Created `handleSpotInterruption.ts` as the EventBridge handler, the `SpotInterruptionBanner` React component, WebSocket message types, and the admin simulator endpoint. An initial Opus code review caught 8 bugs before the first deploy — including a critical issue where `broadcastToUser` was being called with wrong argument order.

**Phase 2 — Bug fixes and hardening (Feb 12 morning):** First deploy revealed several issues. The deploy script was missing the new Lambda function names, so `update-function-code` silently skipped them. The spot connection string regression struck again (third time!) — spot instances use ASG so CloudFormation outputs can't include `PublicIp`, but the code wasn't handling that gracefully. Also discovered that `s3 sync --delete` was destroying admin-uploaded surge pack images that only exist in S3. Fixed with a two-step sync: `--delete --exclude "images/surge-packs/*"` followed by a non-delete sync for just the images.

**Phase 3 — Replacement server flow (Feb 12 afternoon):** Created `replaceSpotServer.ts` — a full API handler for `POST /servers/{serverId}/replace` that clones the original server's configuration (size, instance type, tools, pack, repositories, SSH keys, GitHub tokens) and creates a new CloudFormation stack. Also wired auto-replacement into `handleSpotInterruption.ts` so it fires automatically on interruption. Updated `api-gateway.yaml` with the new resource and `lambdas.yaml` with the new Lambda definition, permissions, and API methods.

**Phase 4 — The EventBridge surprise (Feb 12 evening):** Browser testing revealed the simulator wasn't working — the `handleSpotInterruption` Lambda was never invoked. The simulator was using EventBridge `PutEvents` with `Source: 'aws.ec2'`, which is what real AWS events use. But AWS blocks custom events with `aws.*` sources: `NotAuthorizedForSourceException`. The insidious part was that the SDK didn't throw — it silently dropped the event while returning success. The fix was straightforward: changed the simulator to directly invoke the `handleSpotInterruption` Lambda with `InvokeCommand` using a synthetic EventBridge payload. Required adding `lambda:InvokeFunction` IAM permission and the `@aws-sdk/client-lambda` dependency.

**Phase 5 — Banner UX fix:** After the E2E test worked beautifully (red countdown banner appeared, auto-replacement created a new server visible on the dashboard), clicking "Launch Replacement Now" on a server that was already auto-replaced returned 400. Two issues: the banner defaulted `autoReplaceOnInterruption` to `false` (should be `true` to match backend), and it didn't check if a replacement already existed before showing the button. Fixed to show "View Replacement Server →" link when replacement exists.

### Key Technical Decisions

**Auto-replace by default:** Rather than requiring users to react within the 2-minute window, the system automatically creates a replacement. This was the right call — most users want seamless continuity, and the 2-minute window is too short for someone who might be away from their screen.

**DynamoDB scan for instanceId lookup:** The EventBridge event only contains `instance-id`, not our `serverId`. Rather than add a GSI (which requires stack updates and backfills), we scan the servers table. At MVP scale this is fine — we can add a GSI later if needed.

**Direct Lambda invoke for simulator:** The EventBridge `aws.*` source restriction means we can't inject synthetic events that match real AWS event patterns. Direct invocation is actually better for testing — it's synchronous, easier to debug, and doesn't depend on EventBridge rule matching.

### Bugs Found and Fixed (12 total)

1. Wrong argument order in `broadcastToUser` call
2. Missing `console.error` import in test file
3. History array not properly initialized for first interruption
4. Deploy script missing new Lambda function names
5. Spot instance connection string regression (third time — IP not in DynamoDB for ASG-based instances)
6. `s3 sync --delete` destroying admin-uploaded surge pack images
7. Missing events:PutEvents IAM permission for simulator
8. Missing Lambda::Permission for simulator function
9. EventBridge `NotAuthorizedForSourceException` — custom PutEvents can't use `aws.ec2` source
10. Banner defaulting `autoReplaceOnInterruption` to false instead of true
11. Banner showing "Launch Replacement" button when replacement already exists
12. `vi.mock` for secrets module breaking `clearSecretsCache` in test teardown

### Deployment

Infrastructure deployed in order: api-gateway (new resource + IAM policy) → lambdas (new functions + methods) → backend code (14 server functions + 9 admin functions) → API Gateway forced deployment → frontend build + S3 two-step sync → CloudFront invalidation.

### Commits

- `243d9e0` — Initial spot interruption implementation (EventBridge handler, banner, WebSocket types, simulator)
- `97e51b2` — Fix TypeScript errors
- `3c3c16c` — Fix 8 bugs found during Opus code review
- `7e69fb6` — Add admin simulate button to server detail page
- `ad181c8` — Fix spot interruption bugs and add WebSocket deploy category
- `c0fec2c` — Fix spot instance missing connection string (rockysurf-3ey5)
- `45cbdcc` — Fix frontend deploy to preserve admin-uploaded surge pack images
- `e4dc70b` — Complete spot interruption epic: replacement server flow
- `1ffe676` — Fix simulator: direct Lambda invoke instead of EventBridge
- `91249a5` — Fix banner: default autoReplace to true, show replacement link

### Beads Closed

- Epic `rockysurf-mrt2` and all 17 subtasks (schema, handlers, infrastructure, frontend, tests, docs)
- Bug `rockysurf-3ey5` — Spot connection string regression
- Bug `rockysurf-hwlb` — Deploy script missing Lambda names
- Bug `rockysurf-hj4w` — Missing Lambda::Permission for simulator
- Bug `rockysurf-8e45` — Missing IAM permission for EventBridge
- Bug `rockysurf-33lq` — Misleading autoReplaced flag

---

## 2026-02-13 - OpenClaw Frontend Polish: Connection UX Overhaul

### Summary

The OpenClaw surge pack server detail page had a redundant Connection card sitting next to the Remote Desktop (RDP) card — both showing SSH commands, with the Connection card adding no value since OpenClaw users always connect via RDP tunnel. This session cleaned up the connection UX across both the detail page and dashboard cards, going through several iterations to get the display right.

### The Problem

Looking at the server detail page for an OpenClaw instance, you'd see four cards: Instance Details, Connection, Remote Desktop (RDP), and Tools. The Connection card showed the public IP, an SSH command, and a key download button — all redundant because the RDP card already had the SSH tunnel command. Meanwhile, the SSH commands themselves were missing the `-i` flag entirely when users provided their own SSH key, leaving them with no hint about how to specify their private key path.

### What Changed

The first pass removed the Connection card for OpenClaw servers (non-OpenClaw servers still have it) and changed all SSH commands from `ssh -i server-name.pem rocky@ip` to `ssh -i <path_to_your_key> rocky@ip`. The `-i` placeholder was initially conditional on `keyPairName` being set, but this was wrong — users who bring their own keys need the placeholder too. A quick follow-up made it unconditional.

The dashboard card needed attention as well. The `ServerSummary` API response didn't include `keyPairName`, so it had to be added to the backend type, the `toServerSummary` mapping in `listServers.ts`, and the frontend type. The dashboard RDP command had never included the `-i` flag at all.

### Display Iteration

Getting the visual display right took a few rounds. The raw SSH tunnel command (`ssh -i <path_to_your_key> -L 3389:localhost:3389 rocky@203.0.113.10`) is long and wraps awkwardly in the UI.

First attempt put it in a styled code block with a dark background and border — this stretched the entire RDP card wider than the Instance Details card. Second attempt dropped the code block and showed the command as smaller inline text below the step label, which was better but still looked off because step 1 was vertical while steps 2-3 used horizontal key-value rows.

The final design made all three RDP steps use a consistent vertical layout: numbered label on one line, content below. Steps 2 and 3 became concise one-liners ("Connect to `localhost:3389`" and "Login as `rocky` (password you set at creation)") instead of the awkward two-column layout that was wrapping on smaller screens. The SSH tunnel command gets the full card width with a copy icon on the step header line.

For the dashboard card, the full command was replaced with a compact "Connection command" button that copies the tunnel command to clipboard on click. The dashboard is a summary view — users click through to the detail page for full instructions.

### Files Changed

- `backend/src/lib/types.ts` — Added `keyPairName` to `ServerSummary`
- `backend/src/servers/listServers.ts` — Include `keyPairName` in summary mapping
- `backend/src/servers/listServers.test.ts` — Updated tests for new field
- `frontend/src/lib/api.ts` — Added `keyPairName` to frontend `ServerSummary`
- `frontend/src/pages/ServerDetailPage.tsx` — Removed Connection card for OpenClaw, redesigned RDP card steps, moved SSH key download into RDP card
- `frontend/src/pages/DashboardPage.tsx` — Replaced full command with "Connection command" copy button
- `frontend/src/App.css` — New `.rdp-steps`, `.rdp-step`, `.copy-button-inline` styles

### Beads Closed

- Epic `rockysurf-gu0x` — OpenClaw installations frontend improvements
- Task `rockysurf-ebx2` — Remove Connection card for OpenClaw servers
- Task `rockysurf-b89h` — Add `-i <path_to_your_key>` to SSH/RDP commands
- Bug `rockysurf-sagt` — SSH commands must always show `-i` placeholder regardless of key source

---

## 2026-02-13 — Stripe Billing Integration: Epic 1 (Foundation)

### Summary

Rocky Surf has been running without billing — the founder pays all AWS costs directly. GitHub Issue #8 requested Stripe integration so customers pay for their own servers using a cost-plus model (AWS cost + configurable markup). Today marked the completion of Epic 1: the billing foundation that adds Stripe customer management, payment method enforcement, webhook processing, and a Customer Portal link. Three more epics remain (usage metering, billing enforcement, and UI polish), but the critical "card on file" gate is now live.

### Planning

The integration was designed as a 4-epic plan covering the full billing lifecycle. Key decisions made during planning:

- **Cost-plus billing model** — AWS instance cost + ~35% configurable markup, per-second granularity
- **Stripe Billing with Meters** — usage-based metering rather than fixed-price subscriptions
- **Card-on-file gate** — no server creation without a valid payment method
- **Stripe Customer Portal** — offloads payment method management and invoice history to Stripe's hosted UI rather than building custom billing pages
- **Calendar month billing** — Stripe auto-invoices monthly
- **Failed payment handling** — 3-day grace period, then suspend account and stop all servers
- **Billing exemption** — env-var-driven allowlist for free users (admins auto-exempt)

The full plan lives in `.claude/plans/squishy-skipping-valiant.md`.

### Implementation

Epic 1 touched every layer of the stack — Secrets Manager, DynamoDB, API Gateway, Lambda, and the React frontend.

**Infrastructure** added three Stripe secrets to Secrets Manager (secret key, webhook secret, billing markup config as a NoEcho parameter), new `/billing/*` API Gateway resources (portal-session, webhook, pricing, usage), and five new Lambda functions wired through the lambdas CloudFormation template. The webhook endpoint uses `AuthorizationType: NONE` since it authenticates via Stripe's signature verification instead.

**Backend** introduced `lib/stripe.ts` as the Stripe client helper (lazy-initialized, cold-start cached — same pattern as the existing `lib/secrets.ts`). The OAuth callback now creates a Stripe customer on new user signup, storing the `stripeCustomerId` on the user record. The `createServer` handler gates on payment method — if the user lacks a Stripe customer, has no payment method, or is in `unpaid` status, it returns 403 with a descriptive message. A billing exemption check (`isBillingExempt`) skips the gate for allowlisted usernames set via the `BILLING_EXEMPT_USERS` env var.

The webhook handler processes six event types: `invoice.paid` (clears grace period), `invoice.payment_failed` and `invoice.payment_action_required` (sets grace period), `customer.subscription.updated/deleted` (tracks subscription state), and `payment_method.attached` (auto-creates a metered subscription if the user doesn't have one yet).

**Frontend** added a `/billing` page with a "Manage Billing" button that calls `POST /billing/portal-session` and redirects to Stripe's Customer Portal. The create-server page now checks `user.hasPaymentMethod` and `billingStatus` on mount, showing a banner and disabling submission when billing isn't set up. Navigation was updated with a "Billing" link in the dashboard header.

### Code Review and Fixes

After implementation, a comprehensive code review caught 8 issues ranging from security to correctness:

1. **Webhook table scan** — The webhook handler used `ScanCommand` (full table scan) to find users by `stripeCustomerId`. This would degrade as the user table grew. Fixed by adding a Global Secondary Index (`stripeCustomerId-index`) to the Users DynamoDB table and switching to `QueryCommand`.

2. **Billing gate bypass** — When the user record wasn't found in DynamoDB, the billing gate silently allowed server creation instead of blocking it. Fixed to return 403 "User account not found."

3. **Webhook content handling** — API Gateway Lambda proxy doesn't guarantee raw body preservation for Stripe signature verification. Added `ContentHandling: CONVERT_TO_TEXT` to the webhook integration.

4. **Current-month cost calculation** — `getCurrentUsage` was using lifetime `totalCost` for servers created in the current month, which missed servers running across month boundaries. Rewrote to calculate `pricePerSecond * running_seconds_this_month` using the later of server start or month start.

5. **Dead OPTIONS handler** — The webhook handler had an OPTIONS/CORS handler that would never execute because the webhook doesn't go through CORS (Stripe calls it server-to-server). Removed the dead code.

6. **Missing env vars** — `GetPricingFunction` and `GetCurrentUsageFunction` were missing `USERS_TABLE` in their environment variables. Would have caused runtime errors.

7. **Field naming** — `stripeCustomerId` was typed as a boolean in the API response but named like a string ID. Renamed to `hasStripeCustomer` (boolean) for clarity while keeping the actual ID internal.

8. **Hardcoded markup** — The billing markup percentage was hardcoded in CloudFormation instead of being a NoEcho parameter. Moved to a parameter with `Default: '{"markupPercentage": 35}'` so it can be changed without template edits.

All 8 issues were fixed using parallel Task agents (4 simultaneous agents covering backend fixes, infrastructure changes, field renaming, and secrets configuration). After fixing, 15 additional test failures surfaced because the billing gate now properly rejects users without billing fields. Updated the `testUser` fixture with `stripeCustomerId`, `hasPaymentMethod`, and `billingStatus` fields, and added user record mocks to all `setupAuthMock`/`setupMocks` functions. Final result: 402/402 tests passing.

### Deployment

Deployment followed the established stack order with several gotchas along the way:

1. **Secrets stack** — Used `update-stack` (not `deploy`) with `UsePreviousValue=true` for existing NoEcho params. Initially tried `UsePreviousValue=true` on the new Stripe params too, which failed because they didn't exist in the previous template. Fixed by omitting new params and letting their defaults apply.

2. **DynamoDB** — Added `SpotPricesTable` and `stripeCustomerId-index` GSI on Users table. Clean deploy.

3. **API Gateway** — Added `/billing/*` resources. Deployed before lambdas per the established pattern.

4. **Lambdas** — First attempt hit `S3 NoSuchKey` because `billing.zip` didn't exist in S3 yet (new Lambda functions reference S3 zips that haven't been uploaded). Fixed by running `deploy-backend.sh --function billing` first to build and upload the zip, then retrying the CloudFormation deploy. Forced API Gateway redeployment afterward.

5. **Frontend** — Copied `.env.local` from the main worktree (worktrees don't inherit it — this previously caused a production outage). Built, ran two-step S3 sync (with `--delete` excluding surge pack images, then sync images without `--delete`), and invalidated CloudFront.

Verified billing endpoints respond correctly (401 for unauthenticated requests = expected).

### What Remains

Epic 1 is deployed but the following manual Stripe Dashboard setup is still needed:
- Configure Customer Portal (payment method management, invoice history, branding)
- Create Meter (`server_uptime_cost`), Product, and metered Price
- Set webhook URL pointing to the `/billing/webhook` endpoint
- Store actual Stripe secret key and webhook secret in Secrets Manager (currently using placeholder defaults)

Three more epics remain:
- **Epic 2** — Usage metering, spot price cache, price locking at server creation, usage reporting on stop/terminate
- **Epic 3** — Grace period enforcement, 3D Secure handling, billing alerts
- **Epic 4** — Usage display, cost on server cards, enhanced billing page

### Beads

Epic `rockysurf-bjw5` remains open (tracking full Stripe integration across all 4 epics).

Closed this session:
- `rockysurf-33ou` — Add Stripe secrets to Secrets Manager
- `rockysurf-hjsp` — Install Stripe SDK and create helper library
- `rockysurf-1uio` — Add Stripe/billing fields to types
- `rockysurf-pn0n` — Create Stripe customer on OAuth signup
- `rockysurf-t6zl` — Add billing API resources to API Gateway
- `rockysurf-6w02` — Create billing Lambda handlers
- `rockysurf-j0at` — Free user bypass: skip billing gate for allowlisted users
- `rockysurf-pbmf` — GSI + QueryCommand fix for webhook
- `rockysurf-xxn4` — Billing gate bypass fix
- `rockysurf-478i` — ContentHandling fix for webhook
- `rockysurf-xx8l` — Current-month cost calculation fix
- `rockysurf-3sjd` — Dead OPTIONS handler removal
- `rockysurf-442d` — Missing env vars fix
- `rockysurf-qhvy` — stripeCustomerId field rename
- `rockysurf-vini` — Markup config NoEcho parameter

---

## 2026-02-14/15 - Billing Pricing Model and Stripe Epic Closure

### Summary

Discovered that the Billing page showed $0.00 while the Dashboard showed $0.41 for the same running server. The investigation revealed a deeper problem: the entire billing data pipeline was missing. The Dashboard was faking costs with hardcoded rates client-side, while the Billing page was reading `pricePerSecond` and `totalCost` fields from DynamoDB that nothing ever wrote. This led to a first-principles rethink of the spot pricing model, resulting in a clean flat-rate approach that protects margin while keeping things simple for customers.

### The Spot Pricing Deep Dive

What started as a bug fix turned into a pricing model design session. The key question was: how do you charge customers for spot instances when AWS spot prices fluctuate every 5 minutes and billing data has 24-hour latency?

Research confirmed that AWS spot prices can go *up* during a running instance's lifetime — you pay whatever the current rate is, not the price when you launched. And AWS Cost Explorer data doesn't appear for 12-24 hours after usage, so there's no way to show customers the exact AWS charge in real time.

Three options were evaluated: (A) estimate at launch and reconcile from AWS Cost and Usage Reports daily, (B) cache spot prices every 5 minutes and use time-weighted pricing, or (C) simplify the business model with a flat discount.

Option C won — it's the cleanest for customers and eliminates an entire class of billing complexity.

### The Flat-Rate Spot Model

The final pricing model (documented in `PRICING_MODEL.md`):

- **On-demand:** AWS base rate + 35% markup (unchanged)
- **Spot:** 50% of on-demand + 10% markup = 55% of on-demand price

Two constraints protect margin:
1. **Launch threshold:** Only create a spot instance if the current market price is <= 30% of on-demand. If the market is too expensive, reject the request and suggest on-demand.
2. **MaxPrice ceiling:** Set `MaxPrice` in the EC2 spot request to 50% of on-demand. If spot rises above this, AWS interrupts the instance rather than charging more.

The margin math works out well: at the launch threshold (30% of on-demand), margin is ~45% of customer price. At the ceiling (50%), margin shrinks to ~10%. Below 30% is pure upside. And customers get a clean pitch: "Spot is ~59% cheaper, but may be interrupted."

### Implementation

The fix touched 11 files across backend, frontend, and infrastructure:

**Backend (the core):**
- `types.ts` — Added pricing constants (`ON_DEMAND_MARKUP`, `SPOT_CUSTOMER_DISCOUNT`, `SPOT_CUSTOMER_MARKUP`, `SPOT_LAUNCH_THRESHOLD`, `SPOT_MAX_PRICE_RATIO`) and a `calculatePricePerSecond()` function that serves as the single source of truth for customer pricing.
- `createServer.ts` — Now writes `pricePerSecond` to the Server DynamoDB record at creation time. For spot instances, checks the current spot market price against the 30% threshold before launching (calls `DescribeSpotPriceHistory`), and passes `MaxSpotPrice` as a CloudFormation parameter. If spot price is too high, returns a 400 with a helpful message suggesting on-demand.
- `stopServer.ts` / `terminateServer.ts` — Both now calculate `sessionCost = sessionUptime * pricePerSecond` and accumulate it into `totalCost` in the DynamoDB update expression. The cost persists across start/stop cycles.
- `getCurrentUsage.ts` — Added fallback pricing for pre-existing servers that don't have `pricePerSecond` (uses the same `calculatePricePerSecond()` function). No longer requires the field to exist — it calculates on the fly if missing.
- `listServers.ts` — Now returns `estimatedCost` in `ServerSummary`, calculated server-side from `pricePerSecond * uptime`. For stopped/terminated servers, uses stored `totalCost` plus any current-session accrual.

**Frontend:**
- `DashboardPage.tsx` — Removed the hardcoded `HOURLY_RATES` and `SPOT_DISCOUNT` constants entirely. Cost display now uses `server.estimatedCost` from the API response, which means Dashboard and Billing page are guaranteed to agree (both derive from the same `pricePerSecond`).

**Infrastructure:**
- `ec2-spot.yaml` — Added `MaxSpotPrice` parameter with a `HasMaxSpotPrice` condition. The `SpotOptions` block now conditionally includes `MaxPrice` when the parameter is provided.

### Beads Housekeeping

Also wired up 15 previously-completed Stripe sub-tasks as proper dependencies of the epic (`rockysurf-bjw5`). They had been completed but never linked, which made the epic look empty.

### Beads Closed

- `rockysurf-i9rb` — Billing page shows $0.00 (pricePerSecond/totalCost never written)
- `rockysurf-6n4v` — Spot instance launch constraints (MaxPrice + threshold)
- `rockysurf-bjw5` — **(EPIC) Stripe Integration: Payment & Billing System** — all 17 sub-tasks complete

The Stripe epic is now fully closed. All billing gates, pricing logic, webhook processing, and customer-facing billing UI are implemented and tested (414 tests passing).

---

## 2026-02-15 - Account Deletion, Smoke Tests, and Settings Page Epic Closure

### Summary

Completed the last piece of the Settings Page epic: account deletion ("Danger Zone"). Also built a comprehensive post-deploy smoke test covering all 33 API endpoints and fixed a lurking data-loss bug in the frontend deploy script. With the account deletion task done, all 8 sub-tasks of the Settings Page epic (`rockysurf-32el`) are complete, and the epic is now closed.

### Account Deletion (Danger Zone)

The account deletion feature (`rockysurf-0i9n`) required coordination across seven sub-tasks spanning API Gateway, Lambda, CloudFormation, frontend, and the OAuth login flow. The design choice was *deactivation*, not deletion — user records are never removed from DynamoDB (needed for churn tracking and billing history), but the account is effectively locked out.

When a user hits "Delete Account," the backend: (1) terminates all active servers by deleting their CloudFormation stacks and finalizing session costs, (2) cancels any active Stripe subscriptions immediately while preserving the customer record, (3) marks the user as `deactivated` in the Users table, and (4) revokes the current session. Critically, the OAuth callback now checks the `deactivated` flag and blocks re-login — a deactivated user can't just sign back in.

The frontend presents a red "Delete Account" button inside a Danger Zone section. Clicking it opens a confirmation modal that requires typing your username before the delete button enables — the standard "type to confirm" pattern that prevents accidental clicks. After confirmation, it POSTs to `/user/deactivate` and redirects to the login page.

A WebSocket export naming bug in CloudFormation (`DeactivateUserFunction` was referencing `DeactivateUser` instead of `DeactivateUserFunction` for the function name export) caused the initial deploy to fail — caught and fixed before the endpoint went live.

### Post-Deploy Smoke Test

Built a smoke test script (`scripts/smoke-test.sh`) that hits all 33 API endpoints and verifies none return 5xx errors. The test accepts expected 4xx responses (401 for auth-required endpoints, 403 from API Gateway defaults, 400 for missing parameters) — the goal is catching deployment-breaking regressions, not functional testing. One wrinkle: the new POST `/user/deactivate` endpoint returns 403 (API Gateway's default for missing authentication) rather than 401, because API Gateway rejects the request before the Lambda authorizer even runs. The smoke test was updated to accept both.

### Frontend Deploy Script Fix

Caught a data-loss bug in `deploy-frontend.sh`: the `s3 sync --delete` command was missing `--exclude "images/surge-packs/*"`, which would have destroyed all 6 admin-uploaded surge pack images on every deploy. These images only exist in S3 (they're uploaded through the admin panel, not checked into git), so `--delete` would silently wipe them. Fixed the script to use the two-step sync approach already documented in DEPLOYMENT.md — sync everything except surge packs with `--delete`, then sync surge packs separately without `--delete`.

### Settings Page Epic: Complete

With account deletion done, the Settings Page epic (`rockysurf-32el`) is fully closed. All 8 sub-tasks shipped: page layout/routing, account info, GitHub App connection management, available tools list, billing shortcut, notification preferences placeholder, logout button, and account deletion. The settings page went from empty to feature-complete across a single day of focused work.

### What's Next

Two epics remain ready for work: Customer Defined Tools (`rockysurf-8u6`, P3) and Customer Defined Surge Packs (`rockysurf-yul`, P3, blocked by Tools). The Tools epic is the next logical step — it lets users add their own custom tools to servers, which the Surge Packs feature will build on.

### Beads Closed

- `rockysurf-0i9n` — Account deletion (Danger Zone) — all 7 sub-tasks complete
- `rockysurf-32el` — **(EPIC) Settings Page** — all 8 sub-tasks complete

---

## 2026-02-15 (night) - Max Servers Per Account (GitHub Issue #27)

### The Problem

`createServer.ts` had a hardcoded `MAX_SERVERS_PER_USER = 10` — generous enough to never hit in practice, which meant there was effectively no limit. GitHub Issue #27 asked to lower the default to 3, add per-user overrides, let admins bypass entirely, and create a workflow for users to request limit increases.

### Design Decisions

The approach was intentionally lightweight: rather than adding a new "plans" or "tiers" table, per-user limits are stored as a `maxServers` field directly on the Users table (DynamoDB is schemaless, so no migration needed). Existing users without the field default to 3 in code (`user.maxServers || 3`). A hard cap of 100 prevents anyone from requesting absurd limits. Admins skip the check entirely via the existing `isAdmin()` allowlist.

The limit increase workflow uses a dedicated `LimitRequestsTable` in DynamoDB with two GSIs — `userId-index` for users listing their own requests, and `status-index` for admins filtering by pending/approved/denied. Users submit requests with a reason; admins review them from a dedicated admin page. On approval, `reviewLimitRequest` automatically bumps the user's `maxServers` — no separate step needed.

### Implementation: A 10-Task Epic

This was the biggest single feature shipped so far — 10 sub-tasks spanning backend, frontend, and infrastructure:

**Backend (5 new Lambda handlers):** `requestLimitIncrease` and `listMyLimitRequests` in the auth zip (user-facing), `listLimitRequests`, `reviewLimitRequest`, and `setUserLimit` in the admin zip. The core enforcement lives in `createServer.ts`, which now queries the user's `maxServers` and counts non-terminated servers before allowing creation. The error message tells users exactly where they stand: "Server limit reached (3/3). You can request an increase from Settings."

**Infrastructure:** New DynamoDB table with two GSIs, 6 new API Gateway resources with CORS and OPTIONS methods, 5 new Lambda functions with IAM permissions and API Gateway method integrations — all wired up in CloudFormation. The lambdas.yaml template grew significantly but stayed within the 51KB S3 threshold.

**Frontend:** The Settings page got a `ServerLimitsSection` showing the current limit (or "Unlimited" for admins) with a "Request Increase" button that opens a modal. The Dashboard now shows "X / Y active" server count. `CreateServerPage` displays the specific API error when limits are hit. A new `AdminLimitRequestsPage` provides admins with a table of all requests, status filter tabs, and a review modal for approve/deny with notes.

### The Session Recovery Story

This feature was started in an earlier session that ran out of context mid-way through Task 7 (Settings page UI). A memory checkpoint captured the state — 7 of 10 tasks done, with `ServerLimitsSection` written but never actually rendered in the page's JSX return. Picking up from the checkpoint, the first fix was adding the missing `<ServerLimitsSection />` to `SettingsPage`'s render output. Without the checkpoint, this subtle omission could easily have shipped as a silent bug — the component existed but was invisible to users.

### Deployment Sequence

Adding new API Gateway resources + Lambda functions requires a specific deployment order (documented in DEPLOYMENT.md but worth reinforcing): deploy API Gateway first (new path resources), upload Lambda zips to S3 (so CloudFormation can find them), deploy the lambdas stack (creates the functions), then deploy Lambda code again (the first deploy creates functions with `S3Key: null` — the second actually uploads the code). Finally, force an API Gateway redeployment so the new method integrations take effect. Getting this wrong means Lambdas exist but serve stale or empty code — a gotcha that's bitten before and is now well-documented.

### Testing

25 new tests across 3 files cover all 5 handlers — validation, auth rejection, admin access control, pending duplicate prevention, the approve-updates-user-limit flow, and the deny-doesn't-update-user-limit flow. Also fixed a pre-existing failure in `getMe.test.ts` that broke when `maxServers` was added to the response (the test used `.toEqual()` with an exact object, so any new field fails it). Full suite: 446 tests, all passing.

### Smoke Test Update

The smoke test script now covers 34 endpoints (was 33). All 5 new limit endpoints respond correctly — 401/403 without auth, no 5xx errors.

### Beads Closed

- `rockysurf-hoz2` — **(EPIC) Set default max servers per account** — all 10 sub-tasks complete
- `rockysurf-1ttz` — Backend core limit logic
- `rockysurf-qcxi` — Backend limit increase request endpoints
- `rockysurf-8cpd` — Admin limit management endpoints
- `rockysurf-0qt0` — Infrastructure (DynamoDB + API Gateway + Lambdas)
- `rockysurf-evpc` — Deploy script updates
- `rockysurf-ofup` — Frontend API types & error handling
- `rockysurf-96g6` — Frontend Settings page limit request UI
- `rockysurf-lah7` — Frontend Admin limit requests page
- `rockysurf-ib2n` — Backend tests
- `rockysurf-zjg1` — Deployment and smoke test

### What's Next

GitHub Issue #27 is closed. Two epics remain: Customer Defined Tools (`rockysurf-8u6`, P3) and Customer Defined Surge Packs (`rockysurf-yul`, P3, blocked by Tools).

---

## 2026-02-16 - A Day of Hardening: Billing, Ops, and Stripe Best Practices

This was a dense day focused on production readiness — five GitHub issues closed, spanning billing enforcement, operational improvements, and a thorough Stripe webhook audit.

### Morning: Operational Fixes (Issues #21, #23, #28, #29)

The day started with a quick audit of spot instance auto-termination (Issue #21). The worry was that Rocky Surf itself might be prematurely terminating spot instances, but the investigation confirmed the system was behaving correctly — spot interruptions were genuine AWS reclamations, not self-inflicted. Closed with no code changes needed.

Next came the payment gate (Issue #23). Before this, any authenticated user — even those without a payment method on file — could reach the Create Server page and attempt to provision infrastructure. The fix gates server creation behind `hasPaymentMethod` and `billingStatus`, with billing-exempt users (admins, founders) bypassing the check entirely. The frontend now redirects unpaid users to the billing page with a clear message about what's needed.

Issue #28 turned out to be an availability zone problem — the spot instance availability check was too narrowly scoped, causing "unavailable" errors even when capacity existed in other AZs. Fixed by broadening the zone selection.

Issue #29 externalized the approved users list from a hardcoded array to an SSM Parameter Store parameter, with a 5-minute TTL cache. This means adding or removing users from the allowlist no longer requires a code deploy — just update the SSM parameter. The cache prevents the Lambda from hitting SSM on every request while still picking up changes within minutes.

### Afternoon: Stripe Webhook Best Practices Audit (Issue #24)

This was the biggest piece of work. The audit compared our Stripe integration against current best practices from `docs.stripe.com/llms.txt` and found four actionable gaps in the webhook handler — the most critical billing component in the system, and one that had zero test coverage.

**Idempotency guard.** Stripe can re-deliver webhook events, and our handler was processing every event unconditionally. Added a `StripeEventsTable` in DynamoDB (PAY_PER_REQUEST, TTL-enabled for automatic 7-day cleanup) with conditional writes using `attribute_not_exists(eventId)`. The write-first pattern was chosen deliberately over write-after: it prevents duplicate subscription creation in the `payment_method.attached` handler, which is the only non-idempotent operation. The trade-off — if business logic fails, the event is marked as processed and Stripe retries are blocked — is acceptable because all other operations are simple DynamoDB updates that are naturally idempotent.

**payment_method.detached handler.** When a user removes their payment method via the Stripe Customer Portal, the `hasPaymentMethod` flag in our Users table wasn't being updated — meaning the payment gate could be bypassed. The fix handles a Stripe quirk: on detach events, the `customer` field is `null`, so the customer ID must be read from `previous_attributes`. After identifying the customer, the handler calls `listPaymentMethods` to check if any remain before setting `hasPaymentMethod: false`.

**Subscription status mapping.** The `customer.subscription.updated` handler was only storing the subscription ID and ignoring the status field entirely. Now all 8 Stripe subscription statuses are mapped to 3 internal `BillingStatus` values: `active/trialing` → `active`, `past_due/incomplete` → `grace_period`, `canceled/unpaid/incomplete_expired/paused` → `unpaid`. Unknown future statuses default to `unpaid` with a `console.warn`.

**Observability.** The handler had numerous silent `break` statements — if a customer ID was missing or a user wasn't found, the event was silently acknowledged with 200 OK and no logging. Now every early exit logs a warning with event type, event ID, and customer ID context. The outer catch block also includes the Stripe event context when available, making CloudWatch debugging far easier.

### The Review Gauntlet

After implementation, the code went through five review passes using specialized agents: a general code reviewer, a code simplifier, and then four parallel reviewers for test coverage, silent failures, comment accuracy, and type design. This surfaced additional improvements — the `respond()` and `extractCustomerId()` helpers were extracted, `invoice.payment_failed` and `invoice.payment_action_required` were consolidated into a single case, `BillingStatus` was imported from the existing types module, and `Stripe.Subscription.Status` replaced a bare `string` parameter type.

The review also identified two follow-up items filed as separate beads: a typed `User` interface to replace `Record<string, unknown>` across the codebase (`rockysurf-nrhd`), and implementing actual usage reporting to Stripe Billing Meters (`rockysurf-wnj1`) — the `reportUsage()` function exists but is never called.

### Testing

33 webhook tests cover all 8 event types, the idempotency guard (duplicates, DDB errors), signature verification (missing header, invalid signature, lowercase header), edge cases (expanded customer objects, missing env vars, Stripe API failures, unknown users), and the status mapping matrix (8 Stripe statuses via `it.each`). Full suite: 485 tests, all passing.

### Deployment and Verification

Infrastructure deployed in order: DynamoDB (new StripeEventsTable), lambdas stack (new env var), backend code (`deploy-backend.sh --function billing`). Registered `payment_method.detached` in the Stripe Dashboard webhook config. Sent a test event via Stripe CLI — both `payment_method.attached` and `payment_method.detached` processed correctly with 200 OK responses and proper warning logs for the test customer (not in our Users table, as expected).

### References

- PR #32 (merged): Audit Stripe webhook handler against best practices
- Commits: `ef78b91`, `8cd693e`, `9aff118`, `161cc44`, `a7a2b20`
- Issues closed: #21, #23, #24, #28, #29

### Beads Closed

- `rockysurf-4914` — **(EPIC) Stripe Best Practices Audit** — all 5 tasks complete
- `rockysurf-zna6` — **(EPIC) Stripe webhook review fixes** — all 5 tasks complete
- `rockysurf-ienm` — Webhook idempotency guard
- `rockysurf-dvx2` — payment_method.detached handler
- `rockysurf-kawc` — Subscription status tracking
- `rockysurf-9vg6` — Webhook tests (33 tests)
- `rockysurf-8hcf` — File usage reporting gap issue
- `rockysurf-zna6.1` through `rockysurf-zna6.5` — Review fixes (idempotency timing, logging, types, comments, test gaps)

### What's Next

Two follow-up items from the Stripe audit: `rockysurf-nrhd` (typed User interface, P2) and `rockysurf-wnj1` (usage reporting to Billing Meters, P2). The P3 epics for Customer Defined Tools and Surge Packs remain in the backlog.

---

## 2026-02-17/18 - Stripe Usage Reporting and Billing-Exempt Centralization

### Closing the Billing Loop

The Stripe best practices audit (previous entry) had identified that `reportUsage()` in `lib/stripe.ts` existed but was never called — Stripe Billing Meters were receiving zero usage data, meaning nobody was actually getting billed for compute time. The cost was being tracked in DynamoDB (the `totalCost` field on servers accumulated correctly), but that data never made it to Stripe. This was `rockysurf-wnj1`, the highest-priority follow-up from the audit.

The implementation was a new shared helper, `reportServerUsage()` in `lib/usageReporting.ts`, designed as a best-effort wrapper: it converts USD to cents, looks up the user's `stripeCustomerId` from DynamoDB, and calls Stripe's meter events API. The function short-circuits early for zero-cost sessions, billing-exempt users, users without a Stripe customer ID, and sub-cent amounts that round to zero. Everything is wrapped in try/catch — a Stripe outage should never prevent a user from stopping or terminating their server.

The helper is called in both `stopServer.ts` and `terminateServer.ts`, positioned after the DynamoDB cost update but before the WebSocket status broadcast. It's `await`ed rather than fire-and-forget because Lambda can freeze the process before unresolved promises complete — a subtle but important detail for Lambda environments. When a user terminates an already-stopped server, `sessionCost` is zero (no compute since last stop), so the helper short-circuits immediately with no Stripe call.

The Stripe deduplication identifier uses `{action}-{serverId}-{Date.now()}` with millisecond precision, which is more than sufficient since these calls are sequential within a single Lambda invocation.

### The Code Review Discovery

After committing the usage reporting code, a code review caught something: the `BILLING_EXEMPT_USERS` environment variable was hardcoded per-Lambda in `lambdas.yaml`, and the values were wildly inconsistent. Only `GetMeFunction` had the real list (the operator plus two exempt users) — all other seven Lambda functions had empty strings. This had been harmless before because only GetMe used billing exemption (to control the frontend payment gate UI). But with Stop and Terminate now actively reporting to Stripe, the empty strings meant the two non-admin exempt users would be incorrectly billed.

The admin (the operator) was safe because `isBillingExempt()` checks `isAdmin()` first, and `ADMIN_GITHUB_USERS` was set correctly everywhere. But the other exempt users had no such fallback.

### Centralizing to SSM Parameter Store

Rather than just copying the correct value to all Lambdas (which would create eight copies of a list that needs to stay in sync), the fix was to centralize billing-exempt users in AWS SSM Parameter Store — the same pattern already used for the approved users allowlist (`APPROVED_USERS_SSM_PARAM`). This makes the exempt list manageable at runtime without redeploying infrastructure.

The migration (`rockysurf-9wa0`) touched more files than expected because `isBillingExempt()` had to become async (SSM calls are async, and the 5-minute TTL cache means the first call per cold start hits SSM). Seven callers across six files — `getMe`, `createServer`, `startServer`, `resizeServer`, `handleSpotInterruption`, `replaceSpotServer`, and the new `usageReporting` — all needed `await` added. Making a synchronous function async is a change that ripples outward, but every caller was already in an async context, so the diff was mechanical.

The new SSM parameter lives at `/rocky-surf/{env}/billing-exempt-users`, managed through `scripts/manage-billing-exempt.sh` (modeled after the existing `manage-approved-users.sh`). Error handling defaults to "not exempt" (bill them) if SSM is unreachable — the safe default when a billing system can't verify exemptions.

A subtle test infrastructure issue surfaced during implementation: multiple test files create their own `mockClient(SSMClient)` (class-level mock) while `test/setup.ts` uses `mockClient(ssmClient)` (instance-level mock). These are different mock targets in `aws-sdk-client-mock`. Resetting the class-level mock in a test's `beforeEach` doesn't affect the instance-level mock from setup, and vice versa. The solution was to keep the billing-exempt SSM mock in `beforeAll` (not `afterEach`), avoid resetting it in setup.ts, and let the try/catch in `isBillingExempt` handle cases where individual tests have cleared the SSM mock — it returns `false` (not exempt), which is the correct behavior for tests that don't specifically test billing exemption.

### Deployment

Infrastructure (lambdas stack) deployed to pick up the `BILLING_EXEMPT_SSM_PARAM` env var replacing `BILLING_EXEMPT_USERS` across all eight Lambda functions. Backend deployed for both `servers` (14 Lambdas) and `auth` (6 Lambdas) categories.

### References

- Commits: `ac984cb` (usage reporting), `a097f8a` (SSM migration)
- Beads closed: `rockysurf-wnj1` (Stripe usage reporting), `rockysurf-9wa0` (centralize billing-exempt to SSM)
- 17 new tests added (9 unit tests for `usageReporting`, 3 for `stopServer`, 5 for `terminateServer`), 499 total passing

---

## 2026-08-11 - The Open-Source Pivot: Think, Plan, Debate

After six months as a personal SaaS, Rocky Surf changed missions: become the open-source, self-hosted way to provision AI-agent-ready dev boxes on *any* cloud. The owner won't host anything — users bring their own AWS, Hetzner, GCP, or internal machines, and provisioning goes through a standard interface with vendor-specific plugins.

Planning started with three exploration agents mapping the codebase, and the honest conclusion was uncomfortable: nothing was pluggable. The control plane was ~48 Lambdas, 8 CloudFormation stacks, DynamoDB, and Stripe billing gating server creation; servers were per-server CloudFormation stacks with a 260-line user-data script that read its install plan out of DynamoDB. The one genuinely portable gem was the surge-pack system — tools as *data* (installScript/setupScript/installOrder/runAs rows) rather than code.

Four decisions set the shape: the control plane becomes ONE portable Node app (Hono + Drizzle/SQLite + SSE, web UI in-process); auth defaults to a zero-config single admin with GitHub optional; Stripe goes away entirely (cost *visibility* stays); and the work happens in this repo as a monorepo. An adversarial "phone a friend" debate (Opus, three turns to consensus) then reshaped the plan materially: three bootstrap modes collapsed to two (push over SSH as default, callback for hosted cores); a reconciler and inverted create-ordering were added after spotting that the old code provisioned *before* writing the DB row; `arch` became first-class before the SDK froze; spot instances lost their roadmap slot to idle auto-stop; packs became PR-able YAML files with a CI-enforced author contract; and an MCP server — "give your agent a budget-capped credit card for compute" — was promoted into v0.1. License: MIT, by owner's call. Positioning crystallized as *persistent, yours, on your cloud* — deliberately not the ephemeral-sandbox lane forty other tools occupy.

The plan went into GitHub issue #1, was decomposed into 8 epics / ~50 beads with dependency edges, and the de-risking spike started the same evening: a throwaway Hono mini-app plus real Hetzner and AWS plugins, no CloudFormation anywhere. By midnight the spike had provisioned, bootstrapped, and torn down real servers on both clouds — including host-key pinning with no trust-on-first-use window, and Claude Code installed from one identical plan on both arm64 and amd64 — and produced 45 numbered findings that became 32 freeze amendments. Two were latent data-loss bugs the spec would otherwise have shipped: EC2's eventually-consistent DescribeInstances makes "not-found = terminated" wrong without a grace period, and single-use tokens don't survive lost responses (spend the token, drop the reply, brick the box).

### References
- Plan of record: `.plan/1-open-source-rocky-surf-v0-1.md` · GitHub issue amroja-biz/rockysurf-open#1
- Spike findings: `docs/spike/findings.md` (32 amendments), recordings in `spike/recordings/`

---

## 2026-08-12 - One Night: Design Freeze to a Working Product on Two Clouds

An overnight sprint by a four-agent team, coordinated through beads, took the project from spike findings to a working open-source product. The night closed five epics, all exit-verified on real hardware.

**Design freeze.** Four ADRs (`docs/adr/`) settled the contested amendments — `terminating` state, `Offering.available` ("a price is not an offer"), shared-vs-owned resource ownership, push-as-default — and rejected five others with reasons, including killing the `hostKeys` field outright and refusing a tenth error code in favor of a `providerCode` passthrough. The SDK froze as `@rockysurf/provider-sdk`: sixteen types, zero runtime dependencies, with the *rejections* enforced by tests that grep the source. A real-cloud callback verification then scoped callback mode honestly: making it work from a NAT'd laptop required an SSH tunnel — exactly the connectivity push mode already needs — so callback earns its keep only where core is publicly reachable.

**The port.** Milestone 4a produced the monorepo (six packages plus `packs/`), the Drizzle data layer with Postgres-ready types and the state machine ported verbatim from the Lambda era, an AES-GCM secrets store whose tests grep raw database bytes for leaked plaintext, single-admin auth (opaque tokens — a signature answers no question the revocation lookup doesn't already answer), and an `npx rockysurf` boot path that cold-starts in ~450ms. The 21 seed tools survived contact with the new pack contract badly — only 3 complied — so the seed became a per-tool rewrite: aws-cli dropped entirely, open-claw's private-S3 branding stripped, sudo-under-rocky violations split into honest root/user steps. Milestones 4b/4c rebuilt both providers against the frozen SDK (plain RunInstances with ClientToken idempotency on AWS — the minimal IAM policy shrank from the CloudFormation era's 83 actions to 14), plus tickers with an enforced spend cap, a reconciler that flags orphans but never reaps shared resources, and a composition-root package that finally let real providers reach the registry without breaking the "core imports only the SDK" lint. Milestone 4d ported the whole SPA: wizard, create page with a Requirements selector (arm64 first-class), dashboard and detail pages driven by capabilities instead of `packId === 'open-claw'` hardcodes, costs page that never sums currencies, and pack/tools admin with byte-exact CodeMirror round-trips. The MCP server landed last: HTTP-only (no bypass path by construction), config-file scopes defaulting to read+stop, and a threat model that says plainly that scopes are a guardrail, not a sandbox.

**What the exit runs caught.** The night's defining lesson: every module had passing unit tests while the product could not bootstrap anything. The real-Hetzner exit run found that `runPushBootstrap` had zero callers, the ticker's bootstrap seam was never adapted, install plans were never persisted, and a premature status promotion sealed the only window bootstrap could use — four gaps across individually-correct closed beads. A whole-app wiring test now fails against each gap independently, and the pattern is team law. The AWS run then caught a data-loss bug in already-accepted provider code (the A4 absence-grace trap: core marked a live, billing instance as terminated 100ms after create — and would never have cleaned it up). Both runs ultimately passed through the production stack: Hetzner cpx12 in 149s, AWS t4g/arm64 and t3/amd64 both green, `claude --version` over SSH, zero orphans, total night's cloud spend measured in cents.

**Process notes worth keeping.** The four agents developed real team protocols under fire: claim-echoes after three dispatch/completion crossings; path-scoped commits after `git add` swept in-flight work three times; a no-`--amend` rule after a commit-race incident; and honored capacity flags — two agents declined work with precise self-diagnoses ("my failures migrated from reasoning to small-detail execution"), and one decline came with handoff notes that made the held task better. Browser verification repeatedly out-earned jsdom, finding real bugs mocked tests structurally could not see.

The night ended at the account's session limit with 4e partially done (MCP shipped; CLI, BYO provider, packaging, SSRF hardening, OSS docs remaining), the 4d browser pass and launch epic pending, and a full handoff journaled.

### References
- Handoff: `.plan/HANDOFF-2026-08-12.md` · ADRs: `docs/adr/` · Contracts: `docs/bootstrap-contract.md`, `docs/writing-a-pack.md`
- Exit-run evidence: `docs/providers/aws.md` (policy + caveats), nightly workflow `.github/workflows/nightly-real-cloud.yml`
- Team rules and rulings: `bd memories`
- ~370 beads closed across epics d0no, q5lm, gonw, 55fx, gyp1, hzi7 (tasks), ftl9.1

---
## 2026-08-12 (day) - Finishing 4e, the Browser Pass, and CI That Spends Real Money

The morning session resumed from the overnight handoff and ran the rest of the day on a wave model: a lead session dispatching ephemeral agents per bead, six at the peak, with beads as the only shared memory. Fifty-five beads closed between breakfast and midnight, and the 4e epic went from "partially done" to done.

**The engineering waves.** The SSRF guard landed first (every hop of a pack-import fetch screened against private/link-local/metadata ranges, IPv6 v4-embedded forms included), then a six-agent wave closed out 4e: SECURITY.md written to a cite-what-you-checked standard (every claim verified against code, not the design memos); the conformance suite gained the absence-grace assertions with the fix verified by locally reverting it; the stop/start state machine stopped asserting states the provider hadn't reached; the BYO provider shipped with a TOFU-then-pin host-key design that required an SDK amendment — made by the book, ADR updated in the same commit; packaging shipped with all five acceptance criteria verified live against real Docker; and the IAM-policy verification run — deliberately re-scoped by an owner ruling from "test scaffolding" to "shipped product artifact" — found a real bug in the published policy (the ENI ARN sat under a tag condition the provider's tagging could never satisfy; every self-hoster's first launch would have failed with UnauthorizedOperation). The policy now ships as parameterized CloudFormation with a drift lint, and a real-sshd container run later proved the BYO provider end to end — 70 checks including "terminate is bookkeeping," measured by sshd's own connection count.

**CI grew teeth, one peeled layer at a time.** The full CI story (gitleaks with mutation-tested rules, a pack-smoke matrix that runs every install script twice in one container, tarball verification that npm-installs the packed CLI) was authored in the afternoon, and the first *real* runs then found what no local machine could: a missing `packageManager` pin, GitHub's new immutable-ID OIDC subject format the AWS trust didn't match, `cloudformation deploy` silently reusing old parameters, session tagging on chained role assumption, and a sweep that went blind exactly when the role chain was broken. Each fix went into the templates with comments. By evening both AWS legs ran green *under the published IAM policy itself* — the nightly is now continuous verification of the exact document self-hosters deploy.

**The shared worktree taught its own lessons.** Commits crossed between agents three times before the root cause was named: `git add` is path-scoped but `git commit` takes the whole shared index. The team rule is now pathspec-bounded commits (`git commit --only`), proven live when five foreign staged files were left untouched; crossed commits were repaired with empty `record:` commits rather than history rewrites; and since every agent commits under one git identity, the bead id in the subject line was recognized as the only attribution that exists. A worse incident followed: the nightly's terminate sweep, selecting on the `managed-by` label, deleted a server the owner had created manually mid-run from the same Hetzner project — the audit did its job, then killed the wrong machine. Sweeps are now scoped to the resources each run itself created, CI got its own Hetzner project and token, and a retry-swallowed API response turned out to have been minting one immortal SSH key per lost response all along.

**The browser pass out-earned every test suite.** The owner's click-through found ten real bugs the 135-test web suite structurally could not see: the SPA had *no CSS at all* (the port carried components and tests, never the stylesheets), deep-route reloads served HTML where the browser asked for JavaScript, nothing in the repo ever copied the web bundle into core, three pages rendered without the navbar, the cloud picker hid itself because a config validation failure was silently swallowed, the step timeline never advanced (two event emitters disagreed about vocabulary), the longest phase of a real create reported nothing, start/stop gave zero feedback (nothing in core ever re-synced a transitioning row), the RDP password typed at create was validated and then dropped on the floor (the paste-your-own-SSH-key field died identically, one line away), and the OpenClaw desktop lost its wallpaper. Every fix landed same-day with a structural guard — asset tests, vocabulary-drift tests against core's own schema, wiring tests that drive real SSE into really-rendered pages. The pass also proved the whole happy path on real AWS: create through the UI, key download, SSH in, private repo cloned — which turned into a feature the same evening when the owner asked for per-repository GitHub tokens (`github.tokens`, most-specific-match-wins, selected box-side by the git credential helper).

**Open-source mechanics.** The history scrub produced a verified single-commit public candidate (scorched-earth gitleaks scan, fresh-clone build proof) and an owner decision: publish via a brand-new repo, keeping the old one private as the archive forever. The npm org was claimed, the packages made publish-ready and verified by tarball, and a placeholder locked the CLI name. The owner also stood up a Notion "human board" — the standing rule that anything requiring a human lands there as a card with instructions, not a chat mention.

### References
- Epic close reports: `bd show rockysurf-ftl9` children · browser-pass record: rockysurf-hzi7 close reason
- CI federation lessons: `deploy/aws/nightly-ci.yaml` comments · shared-worktree rules: `bd memories`
- Public-history candidate: rockysurf-ftl9.8 (runbook on the bead)

---

## 2026-08-13 - Launch Assets, and What Filming Them Flushed Out

With the engineering issue closed (launch split to its own issue #2), the day was supposed to be demo production. Instead it became the best QA session of the project: pointing a camera at the product found bugs that a thousand green tests had walked past.

**The spend cap had never worked.** The agent recording the MCP demo clip discovered it could not film the cap refusing a create — because no server row had ever been priced. `insertServer` accepted an hourly cost; nothing passed it; month-to-date spend was structurally zero; the cap refused nothing, on any provider, from any front end. SECURITY.md's central blast-radius promise was, as written, false. The fix priced rows at create from the provider's own offering (currency stored verbatim and never converted; unpriced rows stay honestly unpriced and never block; price-at-create is a documented snapshot), and the proof drives a real ticker into a real 403. The same investigation found the MCP cost context silently crashing on default uncapped installs, and then the *next* blocker: on the no-cloud fake provider, a server never reaches `running` — meaning the advertised credential-free trial run had always ended in a 30-minute timeout. That fix is the day's best design work: the fake provider now acts as its own box, walking the genuinely-rendered install plan through the same progress pipeline a real machine drives — no second promotion path, gated by an SDK capability rather than a provider-id check, opt-in so not one existing test changed. A no-cloud create now reaches ready in 28 seconds with the full timeline lit, and a one-cent cap trips in under seven minutes of wall clock.

**Both MCP clips shipped** — the spend-cap refusal as the primary (core's own words on screen: "Running servers are left alone") and the max-servers variant — each with a script that reproduces it in one command with zero credentials, the single time-cut documented in the tape header. The hero demo went to the owner to record by hand, with a shot list on the human board; the first automated attempt had died on a 500 from a stale long-running core, itself worth a bead about version-skew detection.

**Incidents, honestly logged.** An agent cleaning up scratch processes ran a pattern-match `pkill` and took down the owner's live core mid-session — the one process every brief says not to touch. Five minutes of downtime, no data lost (SQLite is crash-safe), and two permanent rules: kill only PIDs you started and recorded, and never restart the owner's processes (their shell environment carries the config-interpolated secrets; the agent's first restart attempt failed on exactly that). The day's last fixes came from the owner's screenshots: running servers showed no uptime because the dashboard's API type was a hand-written duplicate still declaring the *SaaS-era* field names — TypeScript asserting a shape over a socket without checking it — now collapsed to one declaration with a guard test that reads the field list from core's actual serializer. Still in flight at day's end: `rockysurf mcp` and `rockysurf token` boot the full core (startup recovery included) against a live data directory just to read a config value, and the discovery that "size" is decorative on the MCP/CLI create path.

Remaining before v0.1.0: the owner's hero video, the stranger test, importing the remaining SaaS-era surge packs from the old account, and the launch-day runbook that has been written, verified, and parked on issue #2.

### References
- The cap chain: rockysurf-dec8, rockysurf-8fkz close reasons · clips + reproduction: `docs/media/`
- Incident rules: `bd memories` (never-pkill-by-pattern) · launch: amroja-biz/rockysurf-open#2

---

## 2026-08-13 (afternoon/evening) - Two Providers in Parallel, Skills That Dogfood, and the Owner Goes Live-Testing

The afternoon restructured how the project builds itself, then used the new structure to ship two cloud providers, two Agent Skills, and a provider-docs standard in parallel — while the owner ran the product for real and turned up a fresh crop of bugs no test had seen.

**The worktree-per-issue model.** The shared-worktree wave model had earned its scars (crossed commits, the pkill incident), so the day moved to dedicated worktrees: each GitHub issue gets its own worktree and its own team, and the lead integrates via PRs — merges delegated to the lead by owner ruling. The owner, meanwhile, runs the product only from `~/code/rockysurf-run`, a worktree pinned to the last pushed green commit that agents never touch; after each push the lead fast-forwards it and says so. The dev trunk is explicitly allowed to be broken between commits now, because nobody runs from it.

**The settings saga ended in an ADR.** The morning's config editor over `rockysurf.config.yaml` (m29b) immediately raised the real question: where does that file *live*? The owner's ruling — "settings should not live in the code" — became ADR-0005: the durable home is `~/.rockysurf/config.yaml`, with the cwd-resolution tier retained for other people's checkout workflows, not this machine. Both worktree copies were migrated and deleted the same day. The settings page was then streamlined (5qzg: hide the unbuilt, one token list, help everywhere), and its token boxes were changed to take an environment-variable *name* rather than a token value (4o3o) — so a secret never lands in the file, only a reference interpolated at boot. The old hosted-SaaS tree was deleted outright the same hour (oaw1) — Lambdas, CloudFormation, Stripe docs, deploy scripts — with one salvage commit rescuing the OpenClaw wallpaper asset on the way out.

**GCP and Azure, built in parallel.** Issues #3 and #4 ran as sibling teams in their own worktrees and both merged by early afternoon. The GCP work produced the vendor-SDK ruling now codified in `docs/writing-a-provider.md`: the default is raw REST over fetch, and a vendor library is bought only for the part where hand-rolling is a liability — auth. `@google-cloud/compute` was rejected (roughly two orders of magnitude larger than the auth library it would ride in on); `google-auth-library` was taken for Application Default Credentials alone, contained by the npx-closure lint so it can never reach core. Writing the transport by hand is also what made the API visible: GCE returns HTTP 200 for *accepted*, not *done* — every mutation is a pending Operation whose failure arrives in a later poll, also 200 — and it speaks two separate error vocabularies. Both clouds' status traps are pinned as test-enforced literals (GCE's `TERMINATED` is not terminated; Azure's `stopped` is not deallocated — the billing difference). Integrating Azure over the gcp-first trunk taught a merge lesson now in team law: keep-both conflict resolutions produce syntax damage invisible to marker scans, caught only by running the full gate — and the integration bead is where cross-branch gaps get *fixed*, not just flagged (the merge repaired a Dockerfile the earlier merge had silently broken). Both providers are test-verified; their real-cloud exit runs are owner-gated beads.

**The measured-numbers incident.** The provider-docs team (issue #5), bringing all provider READMEs to one standard, caught `provider-hetzner/src/api.ts` claiming its transport was "~600 lines" as the argument against vendor SDKs. Nobody had counted; the real figure was 1,036, and the number had already propagated into a memory and a draft doc. Correcting it in place would have been self-invalidating — the edit changes the count. The rule that came out of it: a measurement of this repository lives in exactly one dated home and is re-measured, never quoted; only measurements of immutable external artifacts (an npm tarball at a named version) may be inlined. The deeper lesson got recorded too: in the thread *about* invented numbers, both participants independently produced fresh plausible-but-unverified numbers. The failure mode is not carelessness — a quantity makes a sentence feel stronger, and the pressure to produce one outruns the check.

**Skills that had to survive dogfooding.** Issues #7 and #8 shipped two Agent Skills — `creating-surge-packs` and `adding-providers` — into `.claude/skills/`, chosen over a top-level `skills/` because a checkout is required to verify anything anyway and Claude Code auto-discovers them there with zero install steps. The naming convention (directory named for the user's task, as a verb phrase) came from a lead ruling that overturned the lead's own earlier ruling, recorded so nobody relitigates it. The verification bar both teams landed on independently: give a *fresh* agent the skill and nothing else, and have it build the real thing. Three dogfood rounds found what re-reading never would — a code sample that could not work as written, a claim that a package was published when nothing ever has been, an entire missing reference file, and two real repository bugs: the conformance suite wasn't publishable for out-of-tree authors (92nv — it now is, making nine publishable packages), and a seventh pack file failed the suite (d5an). The legacy SaaS "open-code" pack was also imported (gogh), bringing the shipped packs to six.

**The owner's live-testing bug hunt.** The owner spent the evening doing real work with the product — creating boxes that clone one of their private repositories — and every friction point became a same-day fix: repository URLs are now preflighted at create so a typo fails before money is spent, and a missing token match is *named* rather than guessed at (k6xp); a token reference can be saved before its variable is exported without wedging anything (1z5q); a failed row with a live instance accrues cost and says so (4byx); the create screen resolves tokens per-repo live and deploys only the tokens the box needs (18lq); and configured repositories became a picker instead of a text field (mh8f). A pack-sync guard landed the same hour: a boot that loaded no packs deletes none (96ce). The evening's punchline is that the last blocker is the owner's own token — the exported PAT begins `tqr_`, no GitHub prefix, almost certainly a truncated paste. The hunt also filed four new P1s for tomorrow: the config schema rejects the `allowAllCidr` flag SECURITY.md tells operators to set (p5jr), nothing stops a second core opening a live data directory — the pkill incident's structural fix (utjq), a stale long-running core 500ing on create (vbma), and an SPA modal calling a repositories route core doesn't have (8z4r).

By close, everything through the two-day build is done and merged — five providers, six packs, nine publishable packages, two skills, spend caps that fire, a ten-leg CI matrix — and the only open GitHub issue is #2: launch.

### References
- Handoff: `.plan/HANDOFF-2026-08-13.md` · config: `docs/adr/` (ADR-0005)
- Vendor-SDK ruling and numbers: `docs/writing-a-provider.md` ("Vendor SDKs") · skills: `.claude/skills/README.md`
- Merge/measured-numbers/worktree rules: `bd memories` · trunk PRs #9–#15

---
