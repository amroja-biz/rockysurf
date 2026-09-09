# Rocky Surf

Rocky Surf is an open-source productivity tool for software engineers. It provides a lightweight layer for creating and managing Linux VMs running on your own cloud accounts, pre-installed with your favorite AI coding agent harnesses and GitHub repos. The only costs are the ones from your cloud and coding agents.

## Installation

Requires Node 24 or newer.

```bash
npx -y rockysurf
```

## Features

- Works with AWS, GCP, Azure and Hetzner
- Web app and MCP server, both running on your own machine
- Create, stop, start and terminate Servers on every cloud you configured, from one list
- Pre-install your favorite agent harnesses and Tools with a Surge Pack. Eleven ship in the box,
  covering Claude Code, Codex CLI, Amp, OpenCode, Gas Town, Pi and others
- Pre-load public and private GitHub repos
- Reuse your existing SSH keys, or let Rocky Surf make one for you
- Restrict which network may reach SSH on your Servers
- Server count, create-rate and spend caps, enforced server-side so they cover the web app, the
  CLI and MCP alike
- Agent Skills for writing your own Surge Packs and Providers, in this repository
- Share custom Surge Packs and Providers through the Rocky Surf Shop

## MCP basics

Rocky Surf must already be running; the MCP server talks to it over HTTP.

### Mint a token

It is printed once.

```bash
npx -y rockysurf token
```

### Install MCP in Claude Code

```bash
claude mcp add --scope user --env ROCKYSURF_TOKEN=the-token-you-just-minted \
  --env ROCKYSURF_URL=http://127.0.0.1:3000 -- npx -y rockysurf mcp
```

### Install MCP in Codex CLI

```bash
codex mcp add rockysurf --env ROCKYSURF_TOKEN=the-token-you-just-minted \
  --env ROCKYSURF_URL=http://127.0.0.1:3000 -- npx -y rockysurf mcp
```

### MCP Permissions

`mcp.scopes` in the config file governs permissions. Defaults are
`[read, stop]`:

```yaml
mcp:
  scopes: [read, stop]                        # read, stop and start
  # scopes: [read, stop, create]              # ...and create Servers
  # scopes: [read, stop, create, terminate]   # ...and destroy them
```

 `create` and `terminate` are configurable on Rocky Surf's Settings page.

A scope you have not granted means the tool is not offered at all. Tick `create` under
**Settings → MCP**, then reconnect the MCP client.

### Basic MCP usage

> Create a new Rocky Surf EC2 on AWS, medium size, with the OpenCode Surge Pack. Clone
> https://github.com/pyjanitor-devs/pyjanitor. Use my standard ssh key.

> Show me all running Servers.

> Stop the OpenCode EC2.

## Agent Skills

Agent skills are available in the [source code](https://github.com/amroja-biz/rockysurf) under
[`.agents/skills/`](.agents/skills/README.md), not in the npm package. Clone the repository and
any Agent Skills–compatible agent can use them.

### Examples:

_Create a Personal Surge Pack_

> Make me a Surge Pack for Hermes, https://github.com/nousresearch/hermes-agent

_Add a cloud Provider_

> Make a Rocky Surf Provider for Digital Ocean.


Licensed MIT. The Rocky Surf name and logo are not covered by the MIT license.
