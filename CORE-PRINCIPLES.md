# Core Principles

## What Rocky Surf is

Rocky Surf is **BYOC and BYOK**: bring your own cloud, bring your own AI coding keys and
licenses. It stands up boxes on a cloud of your choice, with your favorite coding agents
installed, connected to your GitHub repos — and that is the whole job. Rocky Surf resells
nothing and sits in the middle of nothing: the cloud account is yours, the agent
subscriptions are yours, the repos are yours, and the control plane is a process you run
yourself. Any feature that would make Rocky Surf a party to those relationships — proxying
your cloud spend, pooling your API keys, holding your code — is out of bounds by definition,
not by preference.

## The five principles

Five principles govern every feature in Rocky Surf. They are the test a new idea has to pass:
a feature that serves none of them needs a very good reason to exist, and a feature that works
against one needs a redesign, not an exception. Issues and PRs should name the principle they
serve.

## 1. Make it as easy as possible to create and manage cloud servers for agentic coding

This is the product. The distance between "I want a box" and "I am SSH'd into a box with my
agents installed" is the number we are always shrinking. Sane defaults do the work — a t-shirt
size resolves to a real machine, a pack installs the tools, the Connect panel hands over the
exact command — and full control stays available for whoever wants it (a specific machine
type, a specific architecture, a custom pack). When something fails, the error names the fix,
because a user mid-create should never need to open a cloud console to find out what happened.
Anything that adds a step to the create path has to buy something worth a step.

## 2. Make it as easy as possible to add a new cloud provider

A new cloud is one package and one config block — never a change to core. The provider SDK is
the whole contract: a provider imports it, implements it, and passes the conformance suite,
and core neither knows nor cares which vendor is behind the seam. Vendor SDKs stay inside
their provider (the dependency lints enforce it). `docs/writing-a-provider.md` is the
contract's document; if writing a provider requires reading core's source, that is a bug in
the contract.

## 3. Make it as easy as possible to create Surge Packs

A pack is one YAML file. No registration, no gatekeeping, no build step: a pack that installs
software this project has never heard of is the normal case, not an exception. The format is
small and frozen, the four authoring rules are documented with worked examples, tools defined
in any pack are reusable by id from any other, and CI proves every pack the honest way — by
running it twice in a real container. The community registry exists so a finished pack is
shareable with a URL. `docs/writing-a-pack.md` is the contract.

## 4. Make Rocky Surf easy to extend via modular components

Extension happens behind seams, not through them. The seams are deliberate: core talks to
clouds only through the provider SDK, tools and packs are data rather than code, the web app,
CLI, and MCP server are all thin clients of the same API. Adding capability means adding a
module behind an existing seam — a provider, a pack, a tool, an API consumer. Widening a seam
is a design decision that gets an ADR; going around one is a bug.

## 5. Make it easy to combine components without coding

Composition is configuration, not programming. An operator wires up providers with config
blocks, caps what they can spend with an allowlist, and turns capability on and off without
touching TypeScript. A pack author composes other packs' tools by id and extends a shipped
pack by copying its list — YAML, not code. Where combining two pieces of Rocky Surf requires
writing code today, treat that as a gap this principle wants closed, not as the way things
are.

---

**Using these.** Before building, say which principle the work serves — in the issue, and
again in the PR. When two principles pull in opposite directions (a create-path convenience
that complicates the provider contract, say), the tradeoff is decided deliberately and
recorded in `docs/adr/`, not settled silently in the diff.
