# ADR-0007: Two ways to hand Rocky Surf a GitHub credential, and where each one lives

## Status

Accepted — 2026-08-19. Commissioned by the owner in chat; implemented by `rockysurf-7fyf`
(`.1` the device flow and the routes, `.2` the Settings card and the paste boxes, `.3` this
record). Subsumes `rockysurf-0rw3`, which asked for the per-user token writer this builds.

## Context

Getting a GitHub credential into Rocky Surf took three steps, and two of them happened
somewhere other than the screen you were on: create a PAT on github.com, export it as an
environment variable in the shell that starts the control plane, then type the *variable name*
into Settings. The middle step is the one operators get wrong — a variable exported into a
different shell, or into a shell that has already started the process, produces a config file
that is correct and a start that refuses.

The owner asked for one button instead, and for the precise path to be kept for people who want
it. That request touches three things the repository currently states as policy:

- **There is no device flow in this codebase and no OAuth client id anywhere.**
  `auth.mode: 'github-device'` is an unimplemented enum value (`config/schema.ts`), marked
  `hidden` and `writable: false` in `settings/fields.ts`, refused by name in
  `settings/routes.ts`, and pinned by `settings.test.ts` with the message *"would lock you out
  of this page"*. ADR-0001 removed OAuth outright. So a Connect button has nothing to reuse and
  must bring its own client id.
- **`rockysurf-4o3o` is a standing owner directive** that a credential box takes the NAME of an
  environment variable, because a config file gets backed up, copied to a second machine and
  pasted into an issue, and `${GITHUB_PAT}` survives all of that carrying nothing.
- **`SECURITY.md` states that nothing writes a `github-token` row** in the encrypted store, and
  that the instance-wide `github.pat` reaches every box whoever created it.

## Decision

### 1. An OAuth App, not a GitHub App

The Connect button runs GitHub's **OAuth device flow** against an **OAuth App**.

Verified against GitHub's documentation on 2026-08-19: an OAuth App's user access tokens **do
not expire** unless the app opts in to expiration, while a GitHub App's user access tokens
expire after 8 hours with a 6-month refresh token by default. The owner's requirement is a
durable credential sitting on boxes with nothing phoning home to refresh it, so the choice makes
itself — an OAuth App, with token expiration left off.

Two properties of the device flow follow and are recorded because both are load-bearing:

- it must be **enabled per app** (a checkbox in the app's settings); without it the endpoints
  answer `device_flow_disabled`, which the code surfaces by name because it is the single most
  likely setup mistake and its cure takes ten seconds;
- it needs **no `client_secret`**, which is what makes a client id in a plaintext config file
  the right shape rather than a compromise.

### 2. The operator registers the app; the client id is a config field

`github.oauth.clientId` is a new `kind: 'string'` field — public, not a secret, not masked by
`redactTree`, safe to commit. There is no default.

### 3. The connected token lives in the encrypted secrets store, per user; pasted per-repo PATs live in the config file

Two custody models, on purpose, and each is right where it is.

The connected token goes to `secrets.putGithubToken(userId, token)`:

- **the precedence already existed and was built for this.** `bootstrap/server-secrets.ts`
  reads `secrets.getGithubToken(server.userId) ?? options.githubPat` and its comment says "THE
  STORED TOKEN WINS … when a route to store a personal token lands (`rockysurf-0rw3`), 'my token
  beats the operator's default' is the behaviour that route needs, and it gets it for free".
  Zero precedence work, and nothing about the ordering changed;
- **the store is read live at server-create; the config file is read once at boot.** Writing the
  connected token to the file would make the button mean "click Connect, then stop the process
  and run `./start.sh` again", which is the point of the button, gone;
- **per-user is the correct owner** for a credential minted by one person's click, and it is the
  exact defect `SECURITY.md` warns about for `github.pat`.

Connection metadata — the login, the granted scopes, when it happened — goes in the existing
`settings` key/value table under `github.connection.<userId>` as JSON. No migration. The token
itself never goes there.

Storing a per-user token while `github.pat` is set **warns; it does not refuse**
(`rockysurf-0rw3`'s open question). `putProviderToken`'s refusal exists because an
environment-provided provider credential wins at runtime and a stored copy would go stale;
nothing of the kind applies here, since nothing persists the config value and
per-user-beats-instance-wide is the intended precedence. `GET /api/v1/github/connection` returns
`configFallbackSet` so the page can name the winner in one sentence.

**Disconnect forgets the token locally and does not revoke it at GitHub.** Revocation is an
authenticated call needing the client secret this design deliberately does not have. Every
response and the confirmation say so, with a pointer to github.com/settings/applications.

### 4. `rockysurf-4o3o` is reversed for two fields and upheld everywhere else

`FieldSpec.accepts: 'literal' | 'envVarName'` is a **per-field** flag, defaulting to
`'envVarName'`. It is set to `'literal'` on `github.pat` and `github.tokens.*.pat` and on
nothing else: `providers.hetzner.token` and the BYO host fields keep the old rule, the old
wording and `lib/envRef.ts`.

**The FILE is unchanged.** `config/interpolate.ts`, `config/load.ts`, `config/schema.ts` and
`settings/view.ts` are untouched. A hand-edited `pat: "${GITHUB_PAT}"` keeps loading at boot,
keeps being reported as `state: 'reference'`, keeps round-tripping through the editor unchanged,
and is still the right shape for anyone who wants the file to carry nothing. What changed is
only what the GUI asks for and what it says.

`kind: 'secret'` still means exactly what it meant — redact this field — and the redaction path
did not change: a pasted literal reads back as `state: 'set'` and is never displayed.

## Considered options

**An official Rocky Surf OAuth App, shipping a public client id as a default** — the way `gh`
does. Technically sound and one setup step shorter. Rejected because it makes every self-hosted
installation depend on an app registration a third party controls: amroja-biz could revoke every
user's token, the authorize screen names an organisation the operator has no relationship with,
and it is a standing external dependency in a product whose whole design (ADR-0001) is "runs on
your box, phones nobody".

**The asymmetry is the argument.** Shipping an official app later is a `.default()` on one
config field and nothing else moves. Starting with an official app and later asking every
installation to register its own is a migration with a flag day. The cheap ordering is the one
that was taken.

**A GitHub App instead of an OAuth App** — better-scoped installation tokens, per-repository
grants. Rejected on the expiry requirement above: an 8-hour user token needs a refresh loop and
something to run it, which is a phone-home this product does not have and does not want.

**Writing the connected token into `rockysurf.config.yaml` like any other setting** — one
custody model instead of two. Rejected because the file is read once at boot: the button would
mean "connect, then restart", and the UI would have to say *connected* about something that was
not yet true.

**Refusing to store a per-user token while `github.pat` is set**, mirroring `putProviderToken`.
Rejected: that refusal exists to prevent a stale second copy of an environment-provided
credential, and there is no second copy here. Warning is what the operator actually needs.

**Deleting the env-var rule outright rather than narrowing it.** Rejected: the commission is
about GitHub PATs, and Hetzner's token is still a provider credential in a file people back up.
`fields.test.ts` therefore holds both wordings, so neither can rot.

**GitHub Enterprise Server support in the button.** Not evaluated beyond scoping it out: GHES
device-flow support varies by version, and `github.tokens[].host` already models a self-hosted
forge for the scoped path, so a GHES operator is not blocked. A follow-up would add
`github.oauth.host`.

## Consequences

### Positive

- One click replaces three steps, two of which happened off-screen.
- The connected token takes effect on the next box created — no restart, because the store is
  read live.
- Per-user custody is strictly better than `github.pat` for a multi-user installation: the token
  minted by one person's click lands only on that person's boxes.
- No new dependency. The device flow is three HTTP calls with an injected `fetch`, so the tests
  run offline.
- The per-repo path is unchanged and is still the narrower one.

### Negative

- **`rockysurf.config.yaml` may now contain a literal GitHub token.** `settings/routes.ts`
  creates the file at `0600` and preserves an existing mode across saves, so the tooling does
  not make it worse — but the backup advice in `docs/self-hosting.md` changes from "this file
  carries no credential" to "treat this file as a credential".
- **The connected token is broad.** `repo` is the classic OAuth scope covering private
  repository contents and there is no narrower classic scope that does, so a connected account
  grants read and write across every repository it can reach. Accepted deliberately; the card
  states it before the operator reaches GitHub's authorize screen, and per-repository tokens
  remain for anyone who wants less.
- **Two custody models to explain.** An operator now has to know that one credential lives in
  the file and another in the encrypted store, and why.
- **Setup is one registration longer** than an official app would have been.
- Disconnect cannot revoke, so the honest copy is longer than a Disconnect button usually needs.

### Risks and mitigations

- **Risk:** an operator registers the app and forgets the Enable Device Flow checkbox, and gets
  a one-word error. **Mitigation:** `device_flow_disabled` is handled by name and rendered as
  the checkbox to tick, in core and in the card, with tests on both.
- **Risk:** the paste box prefills a `${VAR}` reference as editable text, and one keystroke
  turns a working reference into a literal. **Mitigation:** for `accepts: 'literal'` a reference
  renders as a state line with an EMPTY input; there is a test for exactly this.
- **Risk:** the device code — a bearer credential for the pending grant — leaks to the browser.
  **Mitigation:** the routes hand out an opaque `flowId` and keep the device code in memory
  server-side; a response-body scan in `github/routes.test.ts` asserts no reply from any of the
  four routes contains it or the token.
- **Risk:** a browser tab polling too fast gets the installation rate-limited.
  **Mitigation:** core throttles server-side, answering `pending` without calling GitHub when a
  poll arrives inside the interval, and honours `slow_down` by lengthening it.
- **Risk:** a config file holding a literal is committed to a repository. **Mitigation:** docs
  say to treat the file as a credential; the `${VAR}` form is still documented and still
  supported for exactly this reason.

## Deliberately unresolved

- **GitHub Enterprise Server.** `github.oauth.host` would point the device endpoints at
  `https://<host>/login/device/code` and the viewer lookup at `https://<host>/api/v3/user`. Left
  out because GHES device-flow support varies by version and the scoped path already covers it.
- **Sign-in with GitHub.** `auth.mode: 'github-device'` is still unimplemented, and Connect
  GitHub does not change that. These are two different uses of one OAuth mechanism: this one
  obtains a credential for cloning, not a way to sign in to Rocky Surf.
- **Scoped per-user tokens.** The store holds one unscoped `github-token` row per user. A stored
  token that later gains a scope would enter the tier it names and win there, without the
  precedence rule changing.

## References

- `packages/core/src/github/device-flow.ts`, `packages/core/src/github/routes.ts` — the flow and
  the four routes.
- `packages/core/src/bootstrap/server-secrets.ts` — "THE STORED TOKEN WINS", written before this
  route existed.
- `packages/core/src/settings/fields.ts` — `FieldSpec.accepts`, and `github.oauth.clientId`.
- `packages/web/src/components/ConnectGitHubCard.tsx` — the card and its state machine.
- `packages/core/src/secrets/route-inventory.test.ts` — the custody rule these routes pass with
  no new exemption.
- GitHub docs, read 2026-08-19: "Authorizing OAuth apps → Device flow", and "Differences between
  GitHub Apps and OAuth apps" on token expiration.

## Related decisions

- ADR-0001 — depends on. "Runs on your box, phones nobody" is the reason an official OAuth App
  was rejected, and the reason OAuth was removed from login in the first place.
- ADR-0005 — complements. The config file this writes a pasted token into is the one ADR-0005
  resolves, created at `0600`.
