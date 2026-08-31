# Writing the guide, and shipping the pack

## Contents

- [The `guide` field](#the-guide-field)
- [Choosing a destination](#choosing-a-destination)
- [1. A pull request against `packs/`](#1-a-pull-request-against-packs)
- [2. Import into a running instance](#2-import-into-a-running-instance)
- [3. Drop the file into `packs/` of a deployment](#3-drop-the-file-into-packs-of-a-deployment)
- [4. Add it as a pack source](#4-add-it-as-a-pack-source)
- [Sharing a pack with other people](#sharing-a-pack-with-other-people)
- [Exporting a pack that was edited in the UI](#exporting-a-pack-that-was-edited-in-the-ui)

## The `guide` field

The pack installs software. It does not — and must not — authenticate it: no credential of the
user's reaches the box during bootstrap, so a freshly built server is a pile of CLIs that all want
a login. `guide` is where you tell them how.

It is displayed on the server's page as soon as the server is running, **as plain text**. The
application does not parse markdown and does not render HTML, deliberately: pack prose is
untrusted input (a pack can arrive by pull request or by URL import), so it is rendered inside a
`<pre>` through React's escaping and a `<script>` tag in a guide shows up as characters. Write it
the way you would write a README in a terminal — short imperative lines, literal commands,
indentation as the only structure:

```yaml
  guide: |
    Everything below runs on the box, as `rocky`, after you have SSH'd in.

    mytool
      mytool auth login       paste an API key from https://example.com/keys
      mytool --help

    GitHub
      gh auth login           then: gh auth setup-git
```

Leading and trailing whitespace is trimmed; the field is optional, and a pack without one shows
nothing. Copy the shape from `packs/open-code.yaml`.

Two rules, both about honesty. They are the reason this field exists at all.

**Say what the box actually has.** If a setup script could not finish something — a daemon it had
no login session to install, a wizard that only works from a desktop, a version pinned below
`@latest` because the newer one does not work — the guide is where the user finds out, not a
support thread. `packs/open-claw.yaml` tells the user which of two states their box is in and
gives the commands for each; `packs/gas-town.yaml` says outright that `gt` is pinned and why
`@latest` would fail.

**`$GITHUB_TOKEN` is not in the user's shell.** It reaches bootstrap steps only. Clones performed
during setup did authenticate with it; `gh` will not. A guide that says "you already have a token"
is wrong, and every shipped guide says `gh auth login` for this reason — a test asserts it.

## Choosing a destination

| Destination | Gets CI on both architectures | Survives a restart | Shareable |
|---|---|---|---|
| Pull request against `packs/` | yes, forever | yes | yes, to everyone |
| Import into a running instance | no | yes, as a database row | as a file or a URL |
| File dropped into a deployment's `packs/` | no | yes, re-read at boot | by shipping the file |
| Added as a pack source (an https URL) | no | yes, as a database row | yes, to anyone with the URL |

The pull request is the intended path and the only one where somebody else's change cannot
silently break the pack. Import is right for a pack that is genuinely private to one operator. A
pack source is right for a pack still being edited, or one other people should be able to
subscribe to without a merge here.

## 1. A pull request against `packs/`

Work through the checklist at the end of `docs/writing-a-pack.md` first, then open the PR. CI runs
the smoke harness for every pack on both `amd64` and `arm64` and gates merge on it.

The one design rule specific to this path: **reference the shared base tool ids, do not redefine
them.** `packs/ai-coding-agents.yaml` defines the base toolchain and the other packs list those
ids. A `toolId` defined in two files is rejected by the loader, naming both.

That sharing has a consequence worth telling the user about, because it is not obvious and it is
the reason to be careful editing an existing file rather than adding a new one: a pack file that
fails validation is skipped at boot, and every file that *references* a tool from the skipped file
is charged with "references unknown tool" and skipped too. A syntax error in
`packs/ai-coding-agents.yaml` alone empties the entire pack picker — every pack, not just that one
— until the file is fixed. Adding a new file of your own cannot do this to anyone; editing the
shared base file can.

## 2. Import into a running instance

**Surge Packs (`/packs`) → Personal → New Surge Pack → Upload a pack file.** The browser reads
the bytes, so there are no restrictions beyond the file being a valid pack.

(A one-off "import from a URL" button used to sit beside this; issue #204 retired it — a `.yaml`
URL now goes through **Add it as a source** instead, below, which remembers the URL and can
refetch and reinstall it, where the old button only ever fetched once. The same SSRF guard
screens both.)

The result is a **database row with no source file**. That has three consequences the user should
hear:

- Boot never overwrites it, so it will not be clobbered by a repository update.
- Boot never restores it either. It lives in the instance's data directory and nowhere else —
  back it up, or keep the `.yaml` you uploaded.
- **Every tool in the imported file is upserted by id.** If your file defines a `toolId` that the
  instance already has — `curl`, `nodejs`, `claude-code` — your definition replaces the existing
  row for *every pack that references it*, instance-wide, until the next restart re-syncs it from
  the file. Reference the base ids rather than redefining them, or namespace your own
  (`acme-curl`), and never ship a file that redefines a shipped tool.

An imported file may reference tools it does not define, as long as those tools already exist in
the instance (they do on a standard deployment, which ships the six packs). If a referenced tool
is missing the import fails with `Tools not found: …`; if it is disabled, `Cannot include disabled
tools: …`.

One convenience: the `packId`-must-match-the-filename rule is dropped on import, since a paste has
no filename.

### What the SSRF guard allows

The control plane holds cloud credentials, so an operator-supplied URL is screened before it is
fetched — and again on every redirect hop:

- **`https` and `http` only.** Anything else: "Only http and https URLs can be imported".
- **Every resolved address must be public.** Loopback, RFC1918 (`10/8`, `172.16/12`,
  `192.168/16`), link-local including `169.254.169.254`, CGNAT `100.64/10` (which is what
  Tailscale uses), multicast and reserved ranges are all refused, as are their IPv6 equivalents
  and v4-mapped/6to4/NAT64 forms. If *any* address a hostname resolves to is blocked, the whole
  name is refused.
- **Up to 5 redirects**, each re-screened.
- **2 MB body cap** and a **15-second timeout** per hop.
- **No credentials are sent.** No `Authorization` header, no cookies.

So: `https://raw.githubusercontent.com/<owner>/<repo>/<ref>/packs/my-pack.yaml` works, and a
public gist works both as `https://gist.githubusercontent.com/<user>/<id>/raw/<file>` and as
`https://gist.github.com/<user>/<id>/raw` (the redirect is followed and re-screened). What does
not work: a private repository or private gist (no credentials are sent, so it 404s), anything on
the operator's LAN, VPN or localhost, and a file over 2 MB.

One trap that produces a confusing error: the response body must be the YAML itself. A GitHub
*blob* URL (`https://github.com/…/blob/…`) fetches fine and then fails with `Invalid pack file`,
because what came back was an HTML page. Use the raw URL.

## 3. Drop the file into `packs/` of a deployment

For an operator running their own Rocky Surf, a pack file in the checkout's `packs/` directory is
loaded **at boot, and only at boot**. There is no watcher: adding or editing a file needs a
restart.

Two things to warn them about:

- In the shipped Docker image the application's own `packs/` directory always wins, so putting a
  file in the `/data` volume's `packs/` does nothing there. That path only applies to a deployment
  whose image has no `packs/` of its own.
- A file that fails validation is logged and skipped — never fatal — and because the reconcile
  deletes rows whose file it no longer sees, the pack **disappears from the picker until the file
  is fixed**. Combined with the cascade above, one bad edit can take out more packs than the one
  being edited. The boot log names every file and every issue.

## 4. Add it as a pack source

A **source** is a URL the instance browses, rather than a file it swallows once. Configure it in
`registry.sources` — or on the **Pack sources** tab of the admin Settings page, which writes the
same file:

```yaml
registry:
  enabled: true
  sources:
    - name: My packs
      url: https://raw.githubusercontent.com/me/my-packs/main/my-pack.yaml
      trust: community
```

**The URL's shape decides what it is.** Ending in `.yaml` or `.yml`, the URL *is* the pack — one
file, nothing else to publish. Anything else is a directory, read the way the community shop is:
`<url>/index.json` (generate it with `rockysurf pack index`), then the paths that listing names,
each pinned by the digest the index records.

What this buys over a one-off import: the pack appears in the shop, **Refresh** picks up your
latest edit, and reinstalling is a click — so it is the right answer while a pack is still moving.
What to tell the user about it:

- **`https` only.** An `installScript` is root shell on their boxes; http would let anything on
  the network rewrite it in transit, digest included.
- **Admin-only, and it applies at the next restart** — the same as every other setting in that
  file.
- **Adding a source fetches and runs nothing.** The pack is fetched when somebody opens the shop,
  installed only after the disclosure has shown them every script, and executed only when a box is
  created with it. Refresh refetches a listing; it never installs.
- **A one-file source has no separately-generated index**, so its digest cannot prove the file
  matches a listing somebody else made. What it does prove is that the bytes installed are the
  bytes that were shown: the file is refetched at install and refused if it changed in between.
- The `trust` label (`community` or `internal`) is the operator's own word, snapshotted when they
  install. There is no `official` — that means "shipped in the release" and no source can claim it.

## Sharing a pack with other people

Publish the `.yaml` somewhere public and fetchable — a raw URL in a repository, or a public gist —
and tell people either to import it from that URL, or to add it as a pack source if they want
your later edits. It is one file; that is the whole distribution story.

Two things to check before publishing a pack for other people's instances:

- **Does it reference tools it does not define?** That is correct and recommended for the standard
  deployment, which ships the base toolchain. If you want a file that works on *any* instance,
  including a stripped-down one, define every tool it needs — and then namespace your ids so it
  never collides with a shipped one.
- **Does it contain anything private?** A pack is shell scripts someone else's box will run as
  root. Never inline a credential; the pack format has no place for one, and secrets are supposed
  to arrive from the environment.

The best destination for a pack that is generally useful is still a pull request against `packs/`,
where CI keeps it working.

## Exporting a pack that was edited in the UI

`GET /api/v1/admin/surge-packs/:packId/export` (the Export button on the admin page) renders any
pack back to a `packs/*.yaml` file — that is the path by which a UI edit becomes a reviewable pull
request rather than a local divergence.

Two properties to know:

- It **inlines every referenced tool**, not only the ones this pack introduced. Re-importing that
  file into a tree that already defines those tools elsewhere is the one case an author has to
  resolve by hand; the loader will name the duplicate.
- The render is faithful but not byte-identical to a hand-written file: **comments are lost** and
  YAML spelling is normalised. If the pack started as a file you wrote, keep editing that file
  rather than round-tripping it through the UI.
