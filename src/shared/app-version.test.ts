import { describe, expect, it } from 'vitest'
import {
  compareAppVersions,
  isPerfPrereleaseAppVersion,
  isPrereleaseAppVersion,
  isValidAppVersion,
  parseLocalBuildMetadata
} from './app-version'

describe('app version comparison', () => {
  it('compares stable and prerelease versions with semver precedence', () => {
    expect(compareAppVersions('1.4.9', '1.5.0')).toBeLessThan(0)
    expect(compareAppVersions('1.5.0-rc.2', '1.5.0-rc.10')).toBeLessThan(0)
    expect(compareAppVersions('1.5.0-rc.10', '1.5.0')).toBeLessThan(0)
    expect(compareAppVersions('v1.5.0+build.2', '1.5.0+build.9')).toBe(0)
  })

  it('rejects incomplete versions and identifies prereleases', () => {
    expect(isValidAppVersion('1.5')).toBe(false)
    expect(isValidAppVersion('1.5.0')).toBe(true)
    expect(isPrereleaseAppVersion('1.5.0-rc.1')).toBe(true)
    expect(isPrereleaseAppVersion('1.5.0')).toBe(false)
    expect(isPerfPrereleaseAppVersion('1.5.0-rc.1.perf')).toBe(true)
    expect(isPerfPrereleaseAppVersion('1.5.0-rc.1')).toBe(false)
  })
})

describe('local build metadata', () => {
  it('parses the local timestamp and commit from stable and RC package versions', () => {
    expect(parseLocalBuildMetadata('1.4.159-local.1750000000123.abcdef123456')).toEqual({
      baseVersion: '1.4.159',
      timestampMs: 1750000000123,
      commit: 'abcdef123456'
    })
    expect(parseLocalBuildMetadata('v1.4.159-rc.0.local.1750000000123.abcdef123456')).toEqual({
      baseVersion: '1.4.159-rc.0',
      timestampMs: 1750000000123,
      commit: 'abcdef123456'
    })
  })

  it('rejects ordinary releases and unsafe or invalid local timestamps', () => {
    expect(parseLocalBuildMetadata('1.4.159')).toBeNull()
    expect(parseLocalBuildMetadata('1.4.159-local.9007199254740992.abcdef1')).toBeNull()
    expect(parseLocalBuildMetadata('1.4.159-local.8640000000000001.abcdef1')).toBeNull()
    expect(parseLocalBuildMetadata('1.4.159-local.not-a-time.abcdef1')).toBeNull()
  })
})
