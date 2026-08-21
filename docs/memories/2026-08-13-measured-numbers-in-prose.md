---
KEY: measured-numbers-in-prose
DATE: 2026-08-13
UPDATED: 2026-08-21
STATUS: active
SOURCE: bd remember, migrated 2026-08-21
---

# Measured numbers decay — give them one dated home, not many

As documented in `docs/writing-a-provider.md` under "Vendor SDKs":

- A measurement **of this repository** belongs in exactly one place, dated, with an instruction
  to re-measure rather than copy. Never write it into the file it measures — the next edit,
  including the edit that corrects the number, makes it stale again.
- A measurement of an **external, immutable artifact** may be inlined safely, as long as you name
  the version. An npm tarball doesn't change once published, so "`@google-cloud/compute@7.1.0` is
  110,039,229 bytes" stays checkable indefinitely. "Measured on 2026-08-13" is a weaker form — it
  doesn't say which version `latest` pointed at when someone read it.

**How this was found**, because the shape repeats: a doc comment claimed a package was "~600
lines" to justify writing a transport by hand instead of taking a vendor SDK. The real number was
1,036 non-test lines — nobody had counted. The wrong figure had already propagated into other
notes and a draft doc section before anyone measured instead of trusting it. Fixing the doc
comment *inside the file it measured* made the fix false the moment it was saved, because the
correction itself changed the line count.

**The lesson that generalizes further than the incident:** while fixing that, two more people —
writing carefully, in a discussion explicitly about the danger of invented numbers — each produced
a fresh, unverified number of their own. So this isn't a carelessness problem fixable by intending
to be careful. A number makes a sentence feel more authoritative, and the pull to produce one runs
ahead of the check.

**Practical rule:** if a number would strengthen a sentence, either measure it right then and say
where it came from, or write the sentence without it. "Its entire HTTP transport is one file"
needs no line count and can't go stale. Prefer that form whenever the exact count isn't
load-bearing — and when it is load-bearing, give it a dated home with a re-measure instruction
instead of copying it around.
