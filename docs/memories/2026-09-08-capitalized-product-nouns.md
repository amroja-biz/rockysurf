# Rocky Surf's four primitives are capitalized product nouns

*For anyone writing prose in this repository: docs, help page, READMEs, skills, CLI and UI copy.*

**Status:** active. Owner ruling, 2026-09-07 (Provider, Surge Pack) and 2026-09-08 (the full list),
recorded on issue [#464](https://github.com/amroja-biz/rockysurf/issues/464).

## The rule

Rocky Surf has four primitives. In prose, each one is written capitalized, as a proper noun,
whenever it means the Rocky Surf concept:

| primitive | what it means | plural |
|---|---|---|
| **Provider** | Rocky Surf's connection to one cloud account (Hetzner, AWS, Azure, GCP, a personal one) | Providers |
| **Surge Pack** | the YAML-defined bundle of software installed on a new Server | Surge Packs |
| **Tool** | one entry inside a Surge Pack: a name, an install script, and what it verifies | Tools |
| **Server** | the cloud virtual machine Rocky Surf creates, stops and terminates | Servers |

"Rocky Surf" is always two words, both capitalized.

## What stays lowercase

The same four words have ordinary senses, and those are written as ordinary words:

- **provider** when it is the cloud's term or someone else's: an *identity provider*, an *OIDC
  provider*, a *service provider*. A "personal Provider" keeps the capital on the noun and the
  adjective lowercase.
- **tool** when it means an MCP tool (`list_servers`, `create_server`), a command-line tool, or
  a tool in the general sense ("the right tool for the job"). "MCP tools" is MCP's own term.
- **server** when it means the Rocky Surf process ("the server is listening on port 3000"), an
  HTTP server, an MCP server, or a vendor's product name. Only the machine Rocky Surf creates
  is a Server.
- **surge pack** never stays lowercase in prose. File names still say `surge-pack` (owner
  ruling 2026-09-07: every file about surge packs says so in its name).

Never change anything a machine reads: identifiers in code, YAML keys (`providers:`, `tools:`),
JSON fields, package names (`@rockysurf/provider-sdk`), file paths, URLs, CLI flags, environment
variable names, quoted command output, or a string a test asserts on. Prose inside a code
comment follows the rule; the identifier beside it does not.

## Why it is a memory

The 2026-09-07 ruling was applied only to the files touched that day and lived in a pass-along.
Within a day the next agent had lowercased "provider" again in new copy. A convention that is
not in `docs/memories/` does not survive a session boundary. The sweep that applied this rule
across the repository is tracked on #464, with a lint that keeps it applied.
