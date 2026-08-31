---
KEY: setup-scripts-verify-what-they-claimed
DATE: 2026-08-31
UPDATED: 2026-08-31
STATUS: active
SOURCE: issue #270 (Azure federated identity bug in the nightly), and pull request #263 before it
---

# A setup step that can be skipped is a setup step that will be, and nothing will say so

`deploy/azure/setup-nightly.sh` teaches Entra to trust GitHub's OIDC token. GitHub writes this
repository's name two ways — the classic `repo:owner/name:ref:refs/heads/main` and an immutable
form carrying numeric ids, `repo:owner@216…/name@133…:ref:…` — and Entra matches a federated
credential's subject **exactly**, so each identity needs one credential per form. Pull request
#263 added the second one. Issue #270 is the same `AADSTS700213: No matching federated identity
record found` refusal, filed after that fix shipped.

The reason the fix could be present and absent at once: the id form was built only `if` the two
numbers came back from `gh api`, and the `else` branch printed a note and carried on. Every
failure of that fetch — an expired GitHub sign-in, an offline laptop, a field that answered
`null` — produced a script that finished, said "Setup is done", wrote the repository variables
that turn the Azure leg on, and left the leg unable to sign in. The only symptom arrived the next
morning, in a workflow log, as an error about Azure.

Rules that follow, and they are not specific to Azure:

- **A step whose absence breaks the product does not get an `else` branch that carries on.** If
  the script cannot do the thing it exists to do, it stops and says what to fix. "Reduced
  functionality" is a legitimate outcome for a feature; it is never one for wiring.
- **Read the state back and compare it with what the other side will send.** Step 10 of the Azure
  script now lists what each identity accepts beside the two subjects GitHub will present, and
  refuses to finish unless both are there. That check costs one API call and turns a night of
  silence into one screenful. Write the comparison, not just the create.
- **A fetched id is only usable when it is the shape you expect.** `null` and `""` are different
  failures and both build a subject Entra would happily store and GitHub would never present.
  Check the shape (here: digits) before putting a fetched value into a security identifier.
- **Verify before you enable, not after.** The read-back runs before the repository variables are
  written, so a setup that cannot sign in leaves the leg skipping — which is a clean, visible
  state — rather than red.
- **A script with no cloud access can still be proven.** Both bugs above were reproduced against
  fake `az` and `gh` shims on `PATH`, including a create that reports success and changes
  nothing. No subscription, no spend, no waiting until morning.
