import { describe, expect, it } from 'vitest'
import { AWS_PROVIDER_ID } from './index.js'

describe('@rockysurf/provider-aws scaffold', () => {
  it('declares the provider id core will key on', () => {
    expect(AWS_PROVIDER_ID).toBe('aws')
  })
})
