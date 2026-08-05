import { describe, expect, it } from 'vitest'
import { createLocalBuildVersion } from './build-mac-local.mjs'
import { parseLocalBuildMetadata } from '../../src/shared/app-version'

describe('createLocalBuildVersion', () => {
  it('creates unique valid prerelease versions without changing the release base', () => {
    expect(createLocalBuildVersion('1.4.159-rc.0', 123456, 'abc123')).toBe(
      '1.4.159-rc.0.local.123456.abc123'
    )
    expect(createLocalBuildVersion('1.4.159', 123456, 'abc123')).toBe('1.4.159-local.123456.abc123')
  })

  it('sanitizes commit identifiers', () => {
    expect(createLocalBuildVersion('1.0.0', 1, 'abc/def')).toBe('1.0.0-local.1.abcdef')
  })

  it('keeps timestamp and commit readable to the renderer through appVersion', () => {
    const version = createLocalBuildVersion('1.4.159-rc.0', 1750000000123, 'abc123456789')
    expect(parseLocalBuildMetadata(version)).toEqual({
      baseVersion: '1.4.159-rc.0',
      timestampMs: 1750000000123,
      commit: 'abc123456789'
    })
  })
})
