# Provider Interface Sketch (SPIKE — NOT FROZEN)

> **Status: non-frozen sketch.** This document exists so the spike (`rockysurf-d0no`) has one
> concrete shape to implement against. The spec freezes in Phase 3 (`rockysurf-q5lm`), **after**
> the spike's findings memo amends whatever below turns out to be wrong. Expect changes.

## ComputeProvider

```ts
export interface ProviderCapabilities {
  stop: boolean                 // stop/start preserving disk (AWS ✓, Hetzner ✓, BYO ✗)
  ipStableAcrossStop: boolean   // false on AWS → drives previousIp/ipChangedAt UX
  canPinHostKey: boolean        // provider can inject core-generated host keys via cloud-init
  userDataMaxBytes: number      // AWS 16384, Hetzner 32768, BYO 0
  generatesUserData: boolean    // false for BYO → core uses SSH push bootstrap only
}

export interface Offering {
  id: string                    // provider-native: 't4g.large', 'cax21'
  cpu: number
  memoryGb: number
  diskGb?: number
  arch: 'amd64' | 'arm64'
  gpu?: { model: string; count: number }   // reserved; unpopulated in v0.1
  hourlyUsd: number | null      // from bundled prices.json (stamped fetchedAt); null = unknown
  region: string
}

export interface ProvisionSpec {
  serverId: string              // rockysurf id, for tagging
  name: string
  offeringId: string
  arch: 'amd64' | 'arm64'
  sshPublicKeys: string[]       // core ALWAYS includes its own generated key
  hostKeys?: { ed25519Private: string; ed25519Public: string }  // when canPinHostKey
  userData: string              // rendered #cloud-config YAML ('' when generatesUserData=false)
  tags: Record<string, string>  // always includes managed-by=<prefix>, server-id=<id>
  idempotencyKey: string        // EC2 ClientToken / Hetzner name-dedupe — DB row exists BEFORE this call
}

export interface InstanceView {
  state: 'pending' | 'running' | 'stopping' | 'stopped' | 'terminated' | 'unknown'
  publicIp?: string
  publicDns?: string
  offeringId?: string
}

export interface ManagedResource {
  kind: string                  // 'instance' | 'security-group' | ...
  providerNativeId: string
  serverId?: string             // from tags, when attributable
}

export interface ComputeProvider<TData = Record<string, unknown>> {
  readonly id: string           // 'aws' | 'hetzner' | 'byo'
  readonly displayName: string
  readonly capabilities: ProviderCapabilities

  validateCredentials(): Promise<void>
  listOfferings(): Promise<Offering[]>
  provision(spec: ProvisionSpec): Promise<{ data: TData }>
  describe(data: TData): Promise<InstanceView>
  terminate(data: TData): Promise<void>       // idempotent: not_found = success
  listManaged(): Promise<ManagedResource[]>   // everything tagged managed-by=<prefix>; feeds reconciler
  stop?(data: TData): Promise<void>           // present iff capabilities.stop
  start?(data: TData): Promise<void>
}
```

## ProviderError

```ts
export type ProviderErrorCode =
  | 'auth' | 'quota' | 'capacity' | 'invalid_spec' | 'not_found'
  | 'rate_limited' | 'conflict' | 'network' | 'unknown'

export class ProviderError extends Error {
  constructor(
    public code: ProviderErrorCode,
    message: string,
    public retryable = false,
    public cause?: unknown,
  ) { super(message) }
}
```

All nine codes above are the complete v0.1 taxonomy.

## Deliberately absent (cut in plan debate — do not add during the spike)

- `interruptible` / `checkInterruption` (spot) — no second implementation to generalize from
- `resize` — same argument
- live pricing APIs, dynamic plugin loading, per-server IAM anything

## Sizes

T-shirt sizes (`small|medium|large`) are UI sugar over a `Requirements { vcpu, memGb, diskGb?, arch, gpu? }`
selector resolved against `listOfferings()` at create time; the resolved `offeringId` + `arch` are stored
on the server row. The spike may hardcode one offering per provider — resolution logic is not under test here.

## The 4 spike exit questions

The mini-app must answer these, recorded end-to-end on both clouds:

1. **push-mode bootstrap with zero on-box cloud coupling** (cloud-config + scp'd agent.sh installs Claude Code);
2. **push from a laptop behind NAT + callback from an unreachable-core topology**;
3. **capability/taxonomy differences expressible without provider `if`s leaking** into core;
4. **full lifecycle create→install→SSH→terminate→zero orphans** (via `listManaged()`).

Findings go to `docs/spike/findings.md` (`rockysurf-d0no.8`), which gates the Phase 3 freeze.
