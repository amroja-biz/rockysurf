# Rocky Surf - Phase 1 Specification

Rocky Surf is the easiest way to rent cloud-based servers for coding with AI agents. We take the guesswork out of provisioning the right servers for your work. Easily create any number of servers that are pre-installed with your favorite agentic coding tool, including Claude Code, Codex, and Amp. Rocky Surf servers connect to your GitHub repo, so that your project is there as soon as it starts, meaning you can get to work immediately.

---

## Table of Contents

1. [Product Overview](#product-overview)
2. [Technical Architecture](#technical-architecture)
3. [Server Provisioning](#server-provisioning)
4. [Server Access](#server-access)
5. [GitHub Integration](#github-integration)
6. [Dashboard](#dashboard)
7. [Authentication](#authentication)
8. [Data Model](#data-model)
9. [Security & Infrastructure](#security--infrastructure)
10. [Appendix](#appendix-existing-ec2-claude-code-skill-reference)

---

## Product Overview

### Value Proposition

Developers using AI coding agents (Claude Code, Codex, Amp) need cloud servers with:
- Sufficient RAM for agentic workloads
- Pre-installed tooling ready to go
- GitHub connectivity without SSH key hassle
- Simple provisioning without AWS expertise

Rocky Surf abstracts away the complexity of EC2 provisioning and delivers ready-to-use development servers.

### Target User

Phase 1 is a personal tool for dogfooding. The product is built with multi-tenant architecture in mind, but this phase focuses on the founder's own usage (5-10 concurrent servers). No billing system - founder pays AWS costs directly.

### Server Sizes

| Size | Instance Type | Approximate Monthly Cost (On-Demand) |
|------|--------------|--------------------------------------|
| Small | t3.medium | ~$33 |
| Medium | t3.large | ~$66 |
| Large | t3.xlarge | ~$133 |

### Pre-Installed Tools

Servers come with configurable tooling. Users select which tools to install at creation time.

**AI Coding Agents (user-selectable):**
- Claude Code
- Codex
- Amp

**Base Tools (always installed):**
- Git CLI
- tmux
- Beads (bd) - task tracking CLI
- Agent Deck - Claude Code session manager
- Beads Viewer

**Tool Configuration:**
The list of available tools is stored in a configurable format (DynamoDB or config file) to allow easy addition of new tools in the future without code changes.

---

## Technical Architecture

### Tech Stack

| Component | Technology |
|-----------|------------|
| Frontend | React + Vite |
| Frontend Hosting | AWS S3 + CloudFront |
| Backend API | AWS Lambda + API Gateway |
| Database | AWS DynamoDB |
| Real-time Updates | WebSocket (API Gateway WebSocket API) |
| Authentication | Custom Lambda (GitHub OAuth) |
| Infrastructure as Code | AWS CloudFormation |
| Server Compute | AWS EC2 (in Rocky Surf's AWS account) |

### AWS Region

**Launch region:** us-east-1 only

### High-Level Architecture

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│                 │     │                 │     │                 │
│  React + Vite   │────▶│  API Gateway    │────▶│    Lambda       │
│  (S3/CloudFront)│     │  (REST + WS)    │     │  Functions      │
│                 │     │                 │     │                 │
└─────────────────┘     └─────────────────┘     └────────┬────────┘
                                                         │
                        ┌────────────────────────────────┼────────────────────────────────┐
                        │                                │                                │
                        ▼                                ▼                                ▼
               ┌─────────────────┐              ┌─────────────────┐              ┌─────────────────┐
               │                 │              │                 │              │                 │
               │    DynamoDB     │              │  CloudFormation │              │   GitHub API    │
               │  (metadata)     │              │  (EC2 stacks)   │              │                 │
               │                 │              │                 │              │                 │
               └─────────────────┘              └─────────────────┘              └─────────────────┘
```

---

## Server Provisioning

### Creation Flow

1. User selects server size (small/medium/large)
2. User selects tools to install (Claude Code, Codex, Amp)
3. User selects GitHub repo(s) from authorized repos dropdown
4. User optionally provides custom server name (auto-generated if not)
5. User selects instance type: On-Demand or Spot
6. User optionally provides their own SSH public key
7. System creates CloudFormation stack
8. System stores server metadata in DynamoDB
9. Dashboard shows "provisioning" status with WebSocket live updates
10. After 10-20 minutes, status changes to "ready"

### Server Naming

- **Default:** Auto-generated (e.g., `rocky-surf-20260201-a1b2c3`)
- **Optional:** User can provide custom name

### On-Demand vs Spot Instances

**On-Demand:**
- Standard EC2 pricing
- Guaranteed availability
- Recommended for most users
- Plain EC2 instance (no ASG)
- Supports stop/start - EIP stays attached, data preserved

**Spot Instances:**
- 60-90% cost savings
- Can be interrupted by AWS with 2-minute warning
- Implemented via Auto Scaling Group with min=1, max=1
- If interrupted, ASG automatically provisions replacement
- Elastic IP ensures the public IP stays the same across replacements
- **No stop/start option** - only terminate (ASGs don't support stopping instances)
- **Dashboard Warning:** "Spot instances can be terminated by AWS at any time. Your coding session will be lost and automatically restarted on a new instance. We highly recommend using atomic commits to avoid losing work."

### CloudFormation Stack
**See the operator's `ec2-claude-code` skill (in their `john-claude-skills` repository) for the template**

Each server is a CloudFormation stack. The architecture differs based on instance type:

**On-Demand Stack:**
- Elastic IP (stays attached across stop/start)
- EC2 instance (Ubuntu 24.04 LTS)
- Security Group (SSH on port 22)
- IAM Instance Profile (EIP association only)
- EIP Association resource (associates EIP to instance)

**Spot Instance Stack:**
- Elastic IP (re-associates on replacement)
- Security Group (SSH on port 22)
- IAM Instance Profile (EIP association only)
- Launch Template with UserData that auto-associates the EIP on boot
- Auto Scaling Group with min=1, max=1

**UserData Script Installs:**
- Selected AI coding tools (Claude Code, Codex, Amp)
- Base tools (git, tmux, npm, Beads (https://github.com/steveyegge/beads), Agent Deck (https://github.com/asheshgoplani/agent-deck), Beads Viewer (https://github.com/Dicklesworthstone/beads_viewer) )
- Node.js 22 LTS
- Playwright with Chromium (headless browser testing)
- GitHub SSH configuration via GitHub App token

### Creation Failure Handling

If CloudFormation stack creation fails:
1. Display AWS error message to user
2. Automatically delete the failed stack (cleanup)
3. Show "Retry" button to attempt again

### Boot Time

**Target:** 10-20 minutes from creation to ready state

This includes:
- EC2 instance launch
- UserData script execution (package installation)
- Tool configuration

---

## Server Access

Users access their servers via SSH. Two options are available:

### 1. Download Key from Dashboard

- Dashboard generates EC2 key pair during server creation
- User downloads .pem file from dashboard
- SSH command: `ssh -i key.pem ubuntu@<public-ip>`

### 2. User-Provided SSH Key

- User provides their public key during server creation
- Public key is injected into CloudFormation template
- User SSHs with their existing private key

### SSH Connection Info

Dashboard displays for each server:
- Elastic IP address (stable across instance replacements)
- Public DNS name
- SSH command (with correct key reference)

---

## GitHub Integration

### Rocky Surf GitHub App

Users install the Rocky Surf GitHub App to grant repository access:
`https://github.com/apps/rocky-surf/installations/new`

**Permissions (already configured):**
- Metadata: Read-only
- Contents: Read/Write
- Pull Requests: Read/Write

### Repository Selection

- Dashboard shows dropdown of repositories authorized via GitHub App
- User selects primary repo during server creation
- Multiple repos can be added to a server after creation

### Multi-Repo Support

- Each server can access multiple repositories
- GitHub App token provides access to all authorized repos
- User adds repos via dashboard; server clones them on demand

### Revoked Access Handling

If a user removes a repository from their GitHub App authorization:
- Dashboard shows warning notification for affected servers
- Server continues running with local copy of code
- Push/pull operations will fail for that repo

---

## Dashboard

### Technology

- React + Vite single-page application
- Hosted on S3 with CloudFront distribution
- Real-time updates via WebSocket connection

### Home Page

Displays at a glance:

1. **Server List**
   - Server name
   - Status (provisioning, running, stopped, terminated)
   - Size (small/medium/large)
   - Instance type (On-Demand/Spot)
   - Uptime
   - Primary repository

2. **Cost Summary**
   - Estimated cost this month (calculated from uptime × hourly rate)
   - Per-server cost breakdown

3. **Recent Activity**
   - Server created
   - Server terminated
   - Server stopped/started
   - Server resized

### Server Detail Page

**Information Displayed:**
- Server name and ID
- Status
- Size and instance type
- Elastic IP / DNS
- Installed tools
- Connected repositories
- Created timestamp
- Uptime
- Estimated cost

**Actions Available:**
- **Start** (if stopped) - On-Demand only
- **Stop** (if running) - On-Demand only
- **Resize** - One-click resize with warning: "This will stop your server, change the instance type, and restart it. Any unsaved work may be lost." (On-Demand only)
- **Terminate** - Confirmation required: "Are you sure? This will permanently delete the server and all data."
- **Add Repository** - Add another authorized repo to this server
- **View SSH Info** - Show SSH connection command and download key (if generated)

Note: Spot instances only have Terminate and Add Repository actions. Stop/Start and Resize are not available for spot instances.

### Settings Page

- GitHub App connection status (connected/not connected)
- Link to manage GitHub App installation
- List of available tools (configurable for future extensibility)
- Logout

### Real-Time Updates

- WebSocket connection to API Gateway
- Server status changes push to all connected clients
- No manual refresh required

---

## Authentication

### GitHub OAuth (Primary)

Users authenticate via GitHub OAuth. This simplifies the flow since GitHub access is already required.

**OAuth Flow:**
1. User clicks "Sign in with GitHub"
2. Frontend redirects to GitHub authorization URL
3. GitHub redirects back with authorization code
4. Lambda exchanges code for access token
5. Lambda fetches user info from GitHub API
6. Lambda creates session, stores in DynamoDB
7. Lambda returns JWT to frontend
8. Frontend stores JWT, includes in subsequent API requests

### Implementation

- Custom Lambda functions (not NextAuth, since we're using React + Vite)
- Modular design to support additional OAuth providers in future
- Sessions stored in DynamoDB with expiration

### Session Management

- JWT tokens for API authentication
- Refresh tokens for extended sessions
- Session data in DynamoDB (user ID, GitHub username, expiration)

---

## Data Model

### DynamoDB Tables

#### Users Table

| Attribute | Type | Description |
|-----------|------|-------------|
| userId | String (PK) | Unique user identifier |
| githubId | String | GitHub user ID |
| githubUsername | String | GitHub username |
| email | String | Email from GitHub |
| createdAt | String (ISO 8601) | Account creation timestamp |
| lastLoginAt | String (ISO 8601) | Last login timestamp |

#### Servers Table

| Attribute | Type | Description |
|-----------|------|-------------|
| serverId | String (PK) | Unique server identifier |
| userId | String (GSI) | Owner's user ID |
| name | String | Server name (custom or auto-generated) |
| size | String | small / medium / large |
| instanceType | String | t3.medium / t3.large / t3.xlarge |
| spotInstance | Boolean | Whether using spot pricing |
| status | String | provisioning / running / stopped / terminated |
| stackName | String | CloudFormation stack name |
| instanceId | String | EC2 instance ID |
| elasticIp | String | Elastic IP address (stable) |
| eipAllocationId | String | EIP allocation ID for CloudFormation |
| publicDns | String | Public DNS name |
| tools | List<String> | Installed tools |
| repositories | List<String> | Connected repo URLs |
| keyPairName | String | EC2 key pair name (if generated) |
| sshPublicKey | String | User-provided public key (if any) |
| createdAt | String (ISO 8601) | Creation timestamp |
| startedAt | String (ISO 8601) | Last start timestamp |
| stoppedAt | String (ISO 8601) | Last stop timestamp |
| terminatedAt | String (ISO 8601) | Termination timestamp (null if active) |
| totalUptimeSeconds | Number | Cumulative uptime for cost calculation |

#### Sessions Table

Used for token revocation. JWTs are stateless and can't be invalidated before expiry unless checked against a session store. On each authenticated request, the API verifies the JWT signature AND checks the session exists. To revoke a token (logout, compromised token), delete the session record.

| Attribute | Type | Description |
|-----------|------|-------------|
| sessionId | String (PK) | Session token (referenced in JWT) |
| userId | String | Associated user ID |
| createdAt | String (ISO 8601) | Session creation |
| expiresAt | String (ISO 8601) | Session expiration |

#### Tools Table (Configuration)

| Attribute | Type | Description |
|-----------|------|-------------|
| toolId | String (PK) | Unique tool identifier |
| name | String | Display name |
| installScript | String | Bash commands to install |
| category | String | "agent" or "base" |
| selectable | Boolean | Whether users can toggle this tool |
| enabled | Boolean | Whether tool is available |

### Data Retention

- **Active servers:** Full metadata retained
- **Terminated servers:** Metadata retained indefinitely for history/auditing
- **User sessions:** Expire after configured TTL, cleaned up automatically

---

## Security & Infrastructure

### Server Isolation

- Each customer's servers run in Rocky Surf's AWS account
- Servers are isolated EC2 instances (VM-level isolation)
- No shared kernel (unlike containers)
- Security groups restrict inbound traffic to SSH only

### IAM Instance Profile

Each EC2 has an IAM role with minimal permissions:
- **ec2:AssociateAddress:** For auto-associating Elastic IP on instance boot (required for spot instance replacement)

**No admin access:** Rocky Surf admins cannot shell into customer servers. This is intentional - customers may have API keys and proprietary code on their servers, and admin access would compromise trust.

### Network Security

- **Inbound:** SSH (port 22) only
- **Outbound:** Full internet access (agents need to install packages, fetch docs, etc.)

### Secrets Management

Rocky Surf does not manage customer API keys (e.g., ANTHROPIC_API_KEY).

Users authenticate their AI tools directly:
- Claude Code: Users run `claude` and complete Anthropic's auth flow
- Codex: Users provide their own authentication
- Amp: Users provide their own authentication

This keeps Rocky Surf out of the secrets management business.

### Server Limits

- **Maximum servers per account:** 10 (arbitrary starting point, can be adjusted)

---

## Appendix: Existing EC2-Claude-Code Skill Reference

Rocky Surf builds upon the existing `ec2-claude-code` skill which provides:
- CloudFormation template for Ubuntu 24.04 EC2
- UserData script installing Claude Code, Playwright, tmux, git, Beads, Agent Deck
- Deploy key generation for GitHub access
- Stack lifecycle management (create/delete)

The skill's CloudFormation template (`cloudformation-ec2-claude-code.yaml`) serves as the foundation, with modifications for:
- GitHub App token authentication (replacing deploy keys)
- SSH access methods (generated key or user-provided key)
- Two stack variants: plain EC2 for On-Demand (supports stop/start), ASG for Spot (auto-replacement)
- Elastic IP (attached directly for On-Demand, auto-associated on boot for Spot)
- Configurable tool selection
- Minimal IAM instance profile (EIP association only, no admin access)

---

## Open Questions

1. **Domain:** What domain will the dashboard use? (Not decided)
2. **Tool Installation:** Exact installation scripts for Codex and Amp (need to research)

---

*Last updated: 2026-02-01*
