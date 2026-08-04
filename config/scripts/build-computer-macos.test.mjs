import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { codesignArgs, resolveSigningIdentity } from './build-computer-macos.mjs'
import {
  FIXTURE_IDENTITY_HASH,
  installElectronBuilderConfigTestFixture
} from './electron-builder-config-test-fixture.mjs'

const require = createRequire(import.meta.url)
const localSigning = require('./macos-local-signing.cjs')
const LOCAL_IDENTITY = 'Orca Kyle Local Development Code Signing'
const LOCAL_IDENTITY_HASH = FIXTURE_IDENTITY_HASH
const KEYCHAIN_PATH = '/private/tmp/orca-kyle-local-signing.keychain-db'
const SECOND_IDENTITY_HASH = '0123456789ABCDEF0123456789ABCDEF01234567'
const ORPHAN_CERT_HASHES = [
  '280B3561727FC9A13A34EE242CE46D9E566A340E',
  'A09FB6FA48236D6177D641EAD358E4C9480244C0',
  'DE0509277BEC9AB515D2BB3CC9004CBFC6A6BC77'
]

let fixtureDirectories = []
let electronBuilderConfig
let configImportFixture

describe.sequential('build-computer-macos signing selection', () => {
  beforeEach(() => {
    if (process.platform !== 'darwin') {
      throw new Error('This test must execute the real macOS local-signing branch on darwin.')
    }
    configImportFixture = installElectronBuilderConfigTestFixture()
    electronBuilderConfig = configImportFixture.requireConfig()
    expect(configImportFixture.securityCalls).toHaveLength(0)
    expect(configImportFixture.existsCalls).not.toContain(configImportFixture.keychainPath)
    expect(electronBuilderConfig.mac.identity).toBe(LOCAL_IDENTITY_HASH)
    expect(configImportFixture.securityCalls).toHaveLength(1)
    expect(configImportFixture.securityCalls[0].command).toBe('/usr/bin/security')
    expect(configImportFixture.securityCalls[0].args).toEqual([
      'find-identity',
      '-v',
      '-p',
      'codesigning',
      configImportFixture.keychainPath
    ])
    expect(configImportFixture.existsCalls).toContain(configImportFixture.keychainPath)
  })

  afterEach(() => {
    configImportFixture?.restore()
    expect(configImportFixture?.isRestored()).toBe(true)
    electronBuilderConfig = undefined
    configImportFixture = undefined

    for (const directory of fixtureDirectories) {
      rmSync(directory, { recursive: true, force: true })
    }
    fixtureDirectories = []
  })

  function renderIdentityOutput(identities) {
    return [
      ...identities.map(
        ({ hash, status }, index) =>
          `  ${index + 1}) ${hash} "${LOCAL_IDENTITY}"${status ? ` (${status})` : ''}`
      ),
      `     ${identities.length} valid identities found`
    ].join('\n')
  }

  function createResolveFixture({
    identities = [],
    identityOutput,
    certificates = [],
    env = {}
  } = {}) {
    const directory = mkdtempSync(join(tmpdir(), 'orca-build-signing-test-'))
    fixtureDirectories.push(directory)
    const keychainPath = join(directory, 'keychains', 'dedicated.keychain-db')
    mkdirSync(join(directory, 'keychains'), { recursive: true })
    writeFileSync(keychainPath, '')
    const certificateOutput = certificates
      .map((hash) => `-----BEGIN CERTIFICATE-----\n${hash}\n-----END CERTIFICATE-----`)
      .join('\n')
    return {
      env: {
        ORCA_LOCAL_MAC_SIGNING_KEYCHAIN: keychainPath,
        ...env
      },
      home: join(directory, 'home'),
      keychainPath,
      run(command, args) {
        if (command !== '/usr/bin/security') {
          throw new Error(`Unexpected fixture command: ${command}`)
        }
        if (args[0] === 'find-identity') {
          return identityOutput ?? renderIdentityOutput(identities)
        }
        if (args[0] === 'find-certificate') {
          return certificateOutput
        }
        throw new Error(`Unexpected fixture security subcommand: ${args[0]}`)
      }
    }
  }

  function resolveFixture(fixture) {
    return localSigning.resolveLocalMacSigningIdentity({
      env: fixture.env,
      home: fixture.home,
      platform: 'darwin',
      run: fixture.run
    })
  }

  function captureError(fn) {
    try {
      fn()
    } catch (error) {
      return error
    }
    return undefined
  }

  it('uses the build-time verified SHA-1 for the helper app codesign argv', () => {
    const localSigning = {
      identity: LOCAL_IDENTITY,
      identityHash: LOCAL_IDENTITY_HASH,
      keychainPath: KEYCHAIN_PATH
    }
    expect(resolveSigningIdentity({ localSigning, env: { ORCA_LOCAL_MAC_SIGNING: '1' } })).toBe(
      LOCAL_IDENTITY_HASH
    )
    expect(
      codesignArgs(LOCAL_IDENTITY, '/private/tmp/Orca Kyle Computer Use.app', { localSigning })
    ).toEqual([
      '--force',
      '--deep',
      '--timestamp=none',
      '--keychain',
      KEYCHAIN_PATH,
      '--sign',
      LOCAL_IDENTITY_HASH,
      '/private/tmp/Orca Kyle Computer Use.app'
    ])
  })

  it('fails closed when local build resolution has no exact hash', () => {
    expect(() =>
      resolveSigningIdentity({
        localSigning: { identity: LOCAL_IDENTITY, keychainPath: KEYCHAIN_PATH },
        env: { ORCA_LOCAL_MAC_SIGNING: '1' }
      })
    ).toThrow('must be exactly 40 hexadecimal characters')
    expect(() => resolveSigningIdentity({ env: { ORCA_LOCAL_MAC_SIGNING: '1' } })).toThrow(
      'refusing name-based fallback'
    )
    expect(() =>
      codesignArgs(LOCAL_IDENTITY, '/private/tmp/helper.app', {
        localSigning: {
          identity: LOCAL_IDENTITY,
          identityHash: 'not-a-sha1',
          keychainPath: KEYCHAIN_PATH
        }
      })
    ).toThrow('must be exactly 40 hexadecimal characters')
  })

  it('preserves explicit external and Apple Development fallback behavior', () => {
    expect(
      resolveSigningIdentity({
        env: { ORCA_COMPUTER_MACOS_SIGN_IDENTITY: 'Developer ID Application: External' },
        securityOutput: ''
      })
    ).toBe('Developer ID Application: External')
    expect(
      resolveSigningIdentity({ env: { CSC_NAME: 'External Identity' }, securityOutput: '' })
    ).toBe('External Identity')

    const identities = [
      '  1) 0123456789ABCDEF0123456789ABCDEF01234567 "Apple Development: Kyle"',
      '  2) 89ABCDEF0123456789ABCDEF0123456789ABCDEF "Developer ID Application: Kyle"'
    ].join('\n')
    expect(resolveSigningIdentity({ env: {}, securityOutput: identities })).toBe(
      'Apple Development: Kyle'
    )
    expect(
      resolveSigningIdentity({ env: { ORCA_MAC_RELEASE: '1' }, securityOutput: identities })
    ).toBe('Developer ID Application: Kyle')
  })

  it('resolves one build-time identity despite three same-name orphan certificates', () => {
    const fixture = createResolveFixture({
      identities: [{ hash: SECOND_IDENTITY_HASH }],
      certificates: [...ORPHAN_CERT_HASHES, SECOND_IDENTITY_HASH]
    })
    expect(fixture.run('/usr/bin/security', ['find-certificate', '-p'])).toContain(
      ORPHAN_CERT_HASHES[0]
    )
    const result = resolveFixture(fixture)
    expect(result.identityHash).toBe(SECOND_IDENTITY_HASH)

    const mainArgs = electronBuilderConfig.__test.localComputerUseCodesignArgs(
      result.identityHash,
      '/private/tmp/Orca Kyle Computer Use.app',
      fixture.keychainPath
    )
    const helperArgs = electronBuilderConfig.__test.localNotificationStatusCodesignArgs(
      result.identityHash,
      '/private/tmp/orca-notification-status',
      fixture.keychainPath
    )
    for (const args of [mainArgs, helperArgs]) {
      expect(args[args.indexOf('--sign') + 1]).toBe(SECOND_IDENTITY_HASH)
      expect(args).not.toContain(LOCAL_IDENTITY)
    }
    expect(
      electronBuilderConfig.__test.getMacSigningIdentity({
        isMacRelease: false,
        isMacLocal: true,
        localMacSigning: result
      })
    ).toBe(SECOND_IDENTITY_HASH)
  })

  it('fails build-time resolution for zero, multiple, malformed, or mismatched identity data', () => {
    const cases = [
      { identities: [], expected: 'not found' },
      {
        identities: [{ hash: LOCAL_IDENTITY_HASH }, { hash: SECOND_IDENTITY_HASH }],
        expected: 'found 2 usable'
      },
      {
        identityOutput: `  1) NOT-A-SHA1 "${LOCAL_IDENTITY}"\n     1 valid identities found`,
        expected: 'malformed'
      }
    ]
    for (const testCase of cases) {
      const fixture = createResolveFixture(testCase)
      const error = captureError(() => resolveFixture(fixture))
      expect(error?.message.toLowerCase()).toContain(testCase.expected)
    }

    const mismatchFixture = createResolveFixture({
      identities: [{ hash: SECOND_IDENTITY_HASH }],
      env: { CSC_NAME: LOCAL_IDENTITY_HASH }
    })
    const mismatchError = captureError(() => resolveFixture(mismatchFixture))
    expect(mismatchError?.message).toContain('does not match')
    expect(() =>
      localSigning.resolveExpectedLocalMacSigningIdentityHash({ CSC_NAME: 'identity name' })
    ).toThrow('must be exactly 40 hexadecimal characters')
  })

  it('passes only the verified hash through localSigningEnvironment', () => {
    expect(
      localSigning.localSigningEnvironment({
        identity: LOCAL_IDENTITY,
        identityHash: LOCAL_IDENTITY_HASH,
        keychainPath: KEYCHAIN_PATH
      })
    ).toMatchObject({
      CSC_NAME: LOCAL_IDENTITY_HASH,
      ORCA_LOCAL_MAC_SIGNING_IDENTITY: LOCAL_IDENTITY_HASH,
      CSC_KEYCHAIN: KEYCHAIN_PATH,
      ORCA_LOCAL_MAC_SIGNING_KEYCHAIN: KEYCHAIN_PATH
    })
  })

  it('keeps release main-app identity selection unmodified', () => {
    expect(
      electronBuilderConfig.__test.getMacSigningIdentity({
        isMacRelease: true,
        isMacLocal: false,
        localMacSigning: null
      })
    ).toBeUndefined()
  })
})
