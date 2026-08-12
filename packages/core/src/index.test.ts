import { describe, expect, it } from 'vitest'
import { CORE_PACKAGE_NAME } from './index.js'

describe('@rockysurf/core scaffold', () => {
  it('is wired into the workspace', () => {
    expect(CORE_PACKAGE_NAME).toBe('@rockysurf/core')
  })
})
