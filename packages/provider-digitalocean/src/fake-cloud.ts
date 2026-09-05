/**
 * A fake DigitalOcean, as a `fetch` route table.
 *
 * NOT A MOCK OF THIS PROVIDER'S OWN METHODS. Every in-tree provider is tested against a fake of
 * the CLOUD's API, because that is what lets the tests assert real behaviour: that `stop()`
 * reaches the state DigitalOcean actually reports, that a replayed create resolves to the original
 * droplet, that `describe()` spends its grace. Mocking the provider's methods would assert only
 * that the test author and the implementation agree.
 *
 * **It speaks DigitalOcean's vocabulary, not the SDK's.** A stopped droplet here has
 * `status: 'off'` — which is the word a really-stopped droplet reports, and precisely the word the
 * state-mapping test exists to catch being mapped wrong. A fake that stored `'stopped'` would hide
 * the bug it is here to find.
 *
 * This file is deliberately NOT a `*.test.ts`: more than one test file uses it, and vitest would
 * otherwise collect it as a suite with no tests in it. It carries no assertions of its own.
 */
import { fingerprintOf } from './provider.js'
import type { DoDroplet, DoFirewall, DoSize, DoSshKey } from './types.js'

export const FAKE_BASE = 'https://digital-ocean.test/v2'

export interface FakeCloud {
  droplets: Map<number, DoDroplet>
  keys: Map<number, DoSshKey>
  firewalls: DoFirewall[]
  sizes: DoSize[]
  regions: { slug: string; available?: boolean }[]
  /** Every request, as `METHOD /path` with the query stripped — for order assertions. */
  requests: string[]
  /** Every request body, keyed in the same order as `requests`. */
  bodies: (unknown | undefined)[]
  /** Reads of the single-droplet read path. The absence-grace harness counts this. */
  dropletReads: number
  nextDropletId: number
  nextKeyId: number
  /** When set, `POST /v2/droplets` answers 422 with this message. */
  createFails?: string
  /** When set, `DELETE /v2/account/keys/{id}` answers 422 with this message. */
  keyDeleteFails?: string
  /**
   * When true, `DELETE /v2/droplets/{id}` answers 204 and LEAVES the droplet readable.
   *
   * That is what a real destroy looks like from the outside for a moment — DigitalOcean has no
   * status word for a teardown in progress, so the droplet stays `active` until it is simply
   * absent. It is the window `terminateRequested` exists for.
   */
  deleteLingers?: boolean
}

export function emptyCloud(overrides: Partial<FakeCloud> = {}): FakeCloud {
  return {
    droplets: new Map(),
    keys: new Map(),
    firewalls: [],
    sizes: [
      {
        slug: 's-1vcpu-1gb',
        memory: 1024,
        vcpus: 1,
        disk: 25,
        price_hourly: 0.00893,
        price_monthly: 6,
        regions: ['nyc3', 'fra1'],
        available: true,
        description: 'Basic',
      },
      {
        slug: 's-2vcpu-4gb',
        memory: 4096,
        vcpus: 2,
        disk: 80,
        price_hourly: 0.03571,
        regions: ['nyc3'],
        available: true,
        description: 'Basic',
      },
      {
        // Withdrawn: still listed for this region, and not orderable. Reported, never omitted.
        slug: 's-1vcpu-2gb-retired',
        memory: 2048,
        vcpus: 1,
        disk: 50,
        price_hourly: 0.01786,
        regions: ['nyc3'],
        available: false,
      },
      {
        // Sold somewhere else entirely, which is not the same as sold out here.
        slug: 'so-2vcpu-16gb',
        memory: 16_384,
        vcpus: 2,
        disk: 300,
        price_hourly: 0.19,
        regions: ['fra1'],
        available: true,
      },
    ],
    regions: [
      { slug: 'nyc3', available: true },
      { slug: 'fra1', available: true },
      { slug: 'ams2', available: false },
    ],
    requests: [],
    bodies: [],
    dropletReads: 0,
    nextDropletId: 1000,
    nextKeyId: 500,
    ...overrides,
  }
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const notFound = () =>
  json(404, { id: 'not_found', message: 'The resource you were accessing could not be found.' })

const unprocessable = (message: string) => json(422, { id: 'unprocessable_entity', message })

/** A page envelope with no `next`, which is how DigitalOcean says "that was the last page". */
const page = (key: string, items: unknown[]) => json(200, { [key]: items, links: {}, meta: { total: items.length } })

export function fakeFetch(cloud: FakeCloud): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> => {
    const url = new URL(String(input))
    const path = url.pathname.replace(/^\/v2/, '')
    const method = (init?.method ?? 'GET').toUpperCase()
    const body = init?.body === undefined ? undefined : (JSON.parse(String(init.body)) as unknown)
    cloud.requests.push(`${method} ${path}`)
    cloud.bodies.push(body)

    if (method === 'GET' && path === '/account') return json(200, { account: { uuid: 'acct' } })

    if (method === 'GET' && path === '/regions') return page('regions', cloud.regions)

    if (method === 'GET' && path === '/sizes') return page('sizes', cloud.sizes)

    if (method === 'GET' && path === '/droplets') {
      const tag = url.searchParams.get('tag_name')
      const all = [...cloud.droplets.values()]
      return page('droplets', tag === null ? all : all.filter((d) => (d.tags ?? []).includes(tag)))
    }

    const dropletId = /^\/droplets\/(\d+)$/.exec(path)?.[1]
    if (dropletId !== undefined) {
      const droplet = cloud.droplets.get(Number(dropletId))
      if (method === 'GET') {
        cloud.dropletReads += 1
        return droplet ? json(200, { droplet }) : notFound()
      }
      if (method === 'DELETE') {
        if (!droplet) return notFound()
        if (!cloud.deleteLingers) cloud.droplets.delete(Number(dropletId))
        return new Response(null, { status: 204 })
      }
    }

    const actionOn = /^\/droplets\/(\d+)\/actions$/.exec(path)?.[1]
    if (actionOn !== undefined && method === 'POST') {
      const droplet = cloud.droplets.get(Number(actionOn))
      if (!droplet) return notFound()
      const type = (body as { type?: string } | undefined)?.type
      if (type === 'shutdown') {
        if (droplet.status === 'off') return unprocessable('Droplet is already powered off.')
        droplet.status = 'off'
      } else if (type === 'power_on') {
        if (droplet.status === 'active') return unprocessable('Droplet is already powered on.')
        droplet.status = 'active'
      } else {
        return unprocessable(`unsupported action ${String(type)}`)
      }
      return json(201, { action: { id: 1, status: 'in-progress', type, resource_id: droplet.id } })
    }

    if (method === 'POST' && path === '/droplets') {
      if (cloud.createFails) return unprocessable(cloud.createFails)
      const spec = body as {
        name: string
        size: string
        tags?: string[]
        user_data?: string
        ssh_keys?: number[]
        vpc_uuid?: string
      }
      const id = cloud.nextDropletId++
      const droplet: DoDroplet = {
        id,
        name: spec.name,
        status: 'new',
        size_slug: spec.size,
        tags: spec.tags ?? [],
        networks: { v4: [] },
      }
      cloud.droplets.set(id, droplet)
      return json(202, { droplet })
    }

    if (method === 'GET' && path === '/account/keys') return page('ssh_keys', [...cloud.keys.values()])

    const keyId = /^\/account\/keys\/(.+)$/.exec(path)?.[1]
    if (keyId !== undefined) {
      const identifier = decodeURIComponent(keyId)
      const key = [...cloud.keys.values()].find(
        (candidate) => candidate.fingerprint === identifier || String(candidate.id) === identifier,
      )
      if (method === 'GET') return key ? json(200, { ssh_key: key }) : notFound()
      if (method === 'DELETE') {
        if (cloud.keyDeleteFails) return unprocessable(cloud.keyDeleteFails)
        if (!key) return notFound()
        cloud.keys.delete(key.id)
        return new Response(null, { status: 204 })
      }
    }

    if (method === 'POST' && path === '/account/keys') {
      const spec = body as { name: string; public_key: string }
      const fingerprint = fakeFingerprint(spec.public_key)
      if ([...cloud.keys.values()].some((key) => key.fingerprint === fingerprint)) {
        return unprocessable('SSH Key is already in use on your account')
      }
      const key: DoSshKey = { id: cloud.nextKeyId++, name: spec.name, fingerprint, public_key: spec.public_key }
      cloud.keys.set(key.id, key)
      return json(201, { ssh_key: key })
    }

    if (method === 'GET' && path === '/firewalls') return page('firewalls', cloud.firewalls)

    if (method === 'POST' && path === '/firewalls') {
      const spec = body as Omit<DoFirewall, 'id'>
      const firewall: DoFirewall = { ...spec, id: `fw-${cloud.firewalls.length + 1}`, status: 'succeeded' }
      cloud.firewalls.push(firewall)
      return json(202, { firewall })
    }

    const firewallId = /^\/firewalls\/(.+)$/.exec(path)?.[1]
    if (firewallId !== undefined && method === 'PUT') {
      const index = cloud.firewalls.findIndex((firewall) => firewall.id === firewallId)
      if (index === -1) return notFound()
      // DigitalOcean's PUT is a whole-object replace: "any attributes that are not provided will
      // be reset to their default values". The fake replaces rather than merges, so a partial
      // write in the provider would show up here as data loss rather than as a passing test.
      const replaced: DoFirewall = { ...(body as Omit<DoFirewall, 'id'>), id: firewallId, status: 'succeeded' }
      cloud.firewalls[index] = replaced
      return json(200, { firewall: replaced })
    }

    return json(404, { id: 'not_found', message: `fake cloud has no route for ${method} ${path}` })
  }) as typeof fetch
}

/**
 * The fingerprint the fake stores against a key.
 *
 * It is the provider's OWN `fingerprintOf`, on purpose: DigitalOcean identifies a key by the MD5
 * of its base64 blob, and a fake that computed something else would make every lookup miss — so
 * "the provider found a key that already existed" could never be tested, which is the branch that
 * decides whether a stranger's key gets reaped.
 */
export function fakeFingerprint(publicKey: string): string {
  return fingerprintOf(publicKey)
}
