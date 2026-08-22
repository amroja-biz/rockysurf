---
KEY: whole-boot-wiring-tests
DATE: 2026-08-21
UPDATED: 2026-08-21
STATUS: active
SOURCE: bd remember, migrated 2026-08-21
---

# Passing unit tests can hide a product that cannot boot

In one area of this project, every module had passing unit tests while the product could not
bootstrap at all. The reason: each test built its own wiring to exercise the code under test, and
asserted behavior against that self-built wiring. A test shaped that way cannot see a missing
piece of the *real* composition, because it never assembles the real thing.

**Rule:** wherever independently-tested modules get wired together — application bootstrap,
service composition, anything with a "boot" or "createApp" step — add a whole-boot wiring test
that exercises the actual composition path, not a stand-in. This project's
`bootstrap/wiring.test.ts` is the pattern; it was verified to independently catch four different
missing-composition gaps that every unit-level test in the area had missed.
`boot-keys.test.ts` catches the same class of bug at the configuration-keys level.
