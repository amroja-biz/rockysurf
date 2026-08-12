import { describe, expect, it } from 'vitest'
import { HETZNER_PROVIDER_ID } from './index.js'

describe('@rockysurf/provider-hetzner scaffold', () => {
  it('declares the provider id core will key on', () => {
    expect(HETZNER_PROVIDER_ID).toBe('hetzner')
  })
})
