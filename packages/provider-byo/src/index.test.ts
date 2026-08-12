import { describe, expect, it } from 'vitest'
import byoProviderFactory, { BYO_PROVIDER_ID } from './index.js'

describe('@rockysurf/provider-byo package surface', () => {
  it('default-exports the factory core loads, matching the id it creates', () => {
    expect(BYO_PROVIDER_ID).toBe('byo')
    expect(byoProviderFactory.id).toBe(BYO_PROVIDER_ID)
    expect(byoProviderFactory.createProvider(byoProviderFactory.configSchema.parse({ hosts: [] })).id).toBe('byo')
  })

  it('constructs without touching the network, the filesystem or a key', () => {
    // The factory contract: `createProvider` is synchronous and side-effect free, so core can
    // load this provider and show its identity before anything is asked of the operator's boxes.
    const config = byoProviderFactory.configSchema.parse({
      hosts: [{ name: 'workshop', host: '10.0.0.9', identityFile: '/does/not/exist' }],
    })
    expect(() => byoProviderFactory.createProvider(config)).not.toThrow()
  })
})
