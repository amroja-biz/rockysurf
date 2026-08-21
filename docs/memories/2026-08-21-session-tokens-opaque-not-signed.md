---
KEY: session-tokens-opaque-not-signed
DATE: 2026-08-21
UPDATED: 2026-08-21
STATUS: active
SOURCE: bd remember, migrated 2026-08-21
---

# Session design: opaque random tokens, not signed cookies

Sessions in this project are opaque random tokens, stored as a SHA-256 hash, validated by a
database lookup — not signed cookies.

**Rationale:** logout/revocation needs the database lookup anyway (a session has to be
invalidatable), so a row existing *is* the proof of validity; a cryptographic signature on top adds
no information a self-hosted deployment needs. Both a bearer token and a cookie are accepted on
authenticated routes — the CLI and MCP surface use the header path.

A session-signing-key mechanism exists in the codebase but is deliberately **dormant**: kept as a
hook for a possible future need, not wired into the current validation path. Don't remove it, and
don't start using it without an ADR update explaining why the opaque-token model no longer
suffices.

The admin password hash lives in application settings (scrypt, one-way) — not in the encrypted
secrets store, because that store exists for things that must be *decrypted*, and a password hash
never is.
