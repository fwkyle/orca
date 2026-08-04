import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import signing from './macos-local-signing.cjs'

const require = createRequire(import.meta.url)

const GENERATED_CERT_HASH = '5EE6B7B408C8E4D21F169376A37543BB2B9F0001'
const UNTRUSTED_CERT_HASH = 'A32F4023600BFDC1E7684C97048FEA9ED87A0A79'
const SECOND_USABLE_HASH = '0123456789ABCDEF0123456789ABCDEF01234567'
const FIXTURE_PASSWORD = 'fixtureStoredKeychainPassword123'
const P12_PASSWORD_ENV = 'ORCA_LOCAL_SIGNING_P12_PASSWORD'

describe('macOS local signing contract', () => {
  it('uses one fixed identity and a dedicated default keychain', () => {
    expect(signing.getLocalMacSigningConfig({}, '/Users/example')).toEqual({
      identity: 'Orca Kyle Local Development Code Signing',
      keychainPath:
        '/Users/example/Library/Application Support/com.chickenbreastky.orca-kyle/local-signing/orca-kyle-local-signing.keychain-db'
    })
  })

  it('accepts only an absolute explicit keychain path', () => {
    expect(
      signing.getLocalMacSigningConfig(
        { ORCA_LOCAL_MAC_SIGNING_KEYCHAIN: '/private/tmp/orca-local.keychain-db' },
        '/Users/example'
      ).keychainPath
    ).toBe('/private/tmp/orca-local.keychain-db')
    expect(() =>
      signing.getLocalMacSigningConfig({ ORCA_LOCAL_MAC_SIGNING_KEYCHAIN: 'relative.keychain-db' })
    ).toThrow('must be an absolute path')
  })

  it('matches only the fixed valid identity and rejects missing extensions', () => {
    const output = [
      '  1) 0123456789ABCDEF0123456789ABCDEF01234567 "Other Development Identity"',
      '  2) 89ABCDEF0123456789ABCDEF0123456789ABCDEF "Orca Kyle Local Development Code Signing"',
      '  3) 76543210FEDCBA9876543210FEDCBA9876543210 "Orca Kyle Local Development Code Signing" (Missing required extension)'
    ].join('\n')
    expect(signing.findMatchingIdentityHashes(output)).toEqual([
      '89ABCDEF0123456789ABCDEF0123456789ABCDEF'
    ])
  })

  it('passes the exact identity and keychain to child signing commands', () => {
    expect(
      signing.localSigningEnvironment({
        identity: 'Orca Kyle Local Development Code Signing',
        keychainPath: '/private/tmp/orca-local.keychain-db'
      })
    ).toEqual({
      ORCA_LOCAL_MAC_SIGNING: '1',
      CSC_NAME: 'Orca Kyle Local Development Code Signing',
      CSC_KEYCHAIN: '/private/tmp/orca-local.keychain-db',
      ORCA_LOCAL_MAC_SIGNING_IDENTITY: 'Orca Kyle Local Development Code Signing',
      ORCA_LOCAL_MAC_SIGNING_KEYCHAIN: '/private/tmp/orca-local.keychain-db'
    })
  })

  it('pins the non-release builder to the fixed identity without notarization', () => {
    const config = require('../electron-builder.config.cjs')
    expect(config.mac.identity).toBe(signing.LOCAL_MAC_SIGNING_IDENTITY)
    expect(config.mac.notarize).toBe(false)
  })

  it('fails closed away from macOS', () => {
    expect(() => signing.verifyLocalMacSigningIdentity({ platform: 'linux' })).toThrow(
      'requires macOS'
    )
  })
})

describe('macOS local signing fail-closed regression (R2)', () => {
  let scratchDirectory

  afterEach(() => {
    if (scratchDirectory) {
      rmSync(scratchDirectory, { recursive: true, force: true })
      scratchDirectory = undefined
    }
  })

  function createScratchSigningPaths() {
    scratchDirectory = mkdtempSync(join(tmpdir(), 'orca-local-signing-test-'))
    return {
      home: join(scratchDirectory, 'home'),
      keychainPath: join(scratchDirectory, 'keychains', 'dedicated.keychain-db')
    }
  }

  function createExistingKeychainFile(keychainPath) {
    mkdirSync(dirname(keychainPath), { recursive: true })
    writeFileSync(keychainPath, '')
  }

  function fixtureEnv(keychainPath) {
    return { ORCA_LOCAL_MAC_SIGNING_KEYCHAIN: keychainPath }
  }

  function captureError(fn) {
    try {
      fn()
    } catch (error) {
      return error
    }
    return undefined
  }

  function fixtureCommandError(label, status, stderr) {
    const error = new Error(
      `macOS local signing command failed: ${label} (exit ${status}): ${stderr}`
    )
    error.status = status
    error.stderr = stderr
    return error
  }

  function parseInteractiveCommand(input) {
    return [...input.trim().matchAll(/"([^"]*)"/g)].map((match) => match[1])
  }

  function renderFindIdentity(state) {
    const lines = state.identities.map(
      (identity, index) =>
        `  ${index + 1}) ${identity.hash} "Orca Kyle Local Development Code Signing"${identity.status ? ` (${identity.status})` : ''}`
    )
    lines.push(`     ${state.identities.length} valid identities found`)
    return lines.join('\n')
  }

  function runFixtureSecurity(state, args, options) {
    const commandArgs = args[0] === '-i' ? parseInteractiveCommand(options.input) : args
    const [subcommand, ...rest] = commandArgs
    switch (subcommand) {
      case 'login-keychain':
        return '"/Users/fixture/Library/Keychains/login.keychain-db"\n'
      case 'find-generic-password': {
        if (state.storedPassword === null) {
          throw fixtureCommandError(
            'security find-generic-password',
            44,
            'The specified item could not be found in the keychain.'
          )
        }
        return `${state.storedPassword}\n`
      }
      case 'add-generic-password':
        state.storedPassword = rest[rest.indexOf('-w') + 1]
        return ''
      case 'unlock-keychain':
      case 'set-keychain-settings':
      case 'set-key-partition-list':
        return ''
      case 'create-keychain':
        return ''
      case 'list-keychains': {
        if (rest.includes('-s')) {
          state.searchList = rest.slice(rest.indexOf('-s') + 1)
        }
        return state.searchList.map((entry) => `    "${entry}"`).join('\n')
      }
      case 'find-identity':
        return renderFindIdentity(state)
      case 'find-certificate':
        return Array.from(
          { length: state.certificateCount },
          () => 'keychain: "/Users/fixture/Library/Keychains/dedicated.keychain-db"'
        ).join('\n')
      case 'import':
        state.identities.push({ hash: GENERATED_CERT_HASH, status: 'CSSMERR_TP_NOT_TRUSTED' })
        state.certificateCount += 1
        return ''
      case 'add-trusted-cert': {
        if (state.trustFails) {
          throw fixtureCommandError(
            'security add-trusted-cert',
            1,
            'User interaction is not allowed'
          )
        }
        for (const identity of state.identities) {
          if (identity.hash === GENERATED_CERT_HASH) {
            identity.status = null
          }
        }
        return ''
      }
      case 'delete-identity': {
        const hash = rest[rest.indexOf('-Z') + 1]
        state.deletedIdentityHashes.push(hash)
        state.identities = state.identities.filter((identity) => identity.hash !== hash)
        state.certificateCount = Math.max(0, state.certificateCount - 1)
        return ''
      }
      default:
        throw new Error(`Unexpected security subcommand: ${subcommand}`)
    }
  }

  function runFixtureOpenssl(state, args) {
    const [subcommand, ...rest] = args
    switch (subcommand) {
      case 'req':
        writeFileSync(rest[rest.indexOf('-keyout') + 1], 'fixture-key')
        writeFileSync(rest[rest.indexOf('-out') + 1], 'fixture-cert')
        return ''
      case 'pkcs12':
        state.keyModeAtPkcs12 = statSync(rest[rest.indexOf('-inkey') + 1]).mode & 0o777
        writeFileSync(rest[rest.indexOf('-out') + 1], 'fixture-p12')
        return ''
      case 'x509':
        return `SHA1 Fingerprint=${GENERATED_CERT_HASH.match(/../g).join(':')}\n`
      default:
        throw new Error(`Unexpected openssl subcommand: ${subcommand}`)
    }
  }

  function createSigningFixture(overrides = {}) {
    const state = {
      storedPassword: FIXTURE_PASSWORD,
      identities: [],
      certificateCount: 0,
      searchList: [],
      trustFails: false,
      deletedIdentityHashes: [],
      keyModeAtPkcs12: null,
      calls: [],
      ...overrides
    }
    const run = (command, args, options = {}) => {
      state.calls.push({ command, args, options })
      if (command === '/usr/bin/security') {
        return runFixtureSecurity(state, args, options)
      }
      if (command === '/usr/bin/openssl') {
        return runFixtureOpenssl(state, args)
      }
      throw new Error(`Unexpected command: ${command}`)
    }
    return { state, run }
  }

  function securitySubcommand(call) {
    return call.args[0] === '-i' ? parseInteractiveCommand(call.options.input)[0] : call.args[0]
  }

  function calledSecuritySubcommands(state) {
    return state.calls
      .filter((call) => call.command === '/usr/bin/security')
      .map(securitySubcommand)
  }

  function findSecurityCall(state, subcommand) {
    return state.calls.find(
      (call) => call.command === '/usr/bin/security' && securitySubcommand(call) === subcommand
    )
  }

  function findOpensslCall(state, subcommand) {
    return state.calls.find(
      (call) => call.command === '/usr/bin/openssl' && call.args[0] === subcommand
    )
  }

  it('treats identities with a parenthesized status as unusable for codesign', () => {
    const output = [
      `  1) ${UNTRUSTED_CERT_HASH} "Orca Kyle Local Development Code Signing" (CSSMERR_TP_NOT_TRUSTED)`,
      '  2) 76543210FEDCBA9876543210FEDCBA9876543210 "Orca Kyle Local Development Code Signing" (Missing required extension)',
      `  3) ${SECOND_USABLE_HASH} "Orca Kyle Local Development Code Signing"`
    ].join('\n')
    expect(signing.findMatchingIdentityHashes(output)).toEqual([SECOND_USABLE_HASH])
    expect(signing.findUntrustedIdentityEntries(output)).toEqual([
      { hash: UNTRUSTED_CERT_HASH, status: 'CSSMERR_TP_NOT_TRUSTED' },
      { hash: '76543210FEDCBA9876543210FEDCBA9876543210', status: 'Missing required extension' }
    ])
  })

  it('verify fails closed with hash and Keychain Access guidance when the identity is untrusted', () => {
    const { home, keychainPath } = createScratchSigningPaths()
    createExistingKeychainFile(keychainPath)
    const { run } = createSigningFixture({
      identities: [{ hash: UNTRUSTED_CERT_HASH, status: 'CSSMERR_TP_NOT_TRUSTED' }]
    })
    const error = captureError(() =>
      signing.verifyLocalMacSigningIdentity({
        env: fixtureEnv(keychainPath),
        home,
        platform: 'darwin',
        run
      })
    )
    expect(error?.message).toContain('not trusted for code signing')
    expect(error?.message).toContain(UNTRUSTED_CERT_HASH)
    expect(error?.message).toContain('CSSMERR_TP_NOT_TRUSTED')
    expect(error?.message).toContain('Keychain Access')
    expect(error?.message).toContain('pnpm setup:mac-local-signing')
  })

  it('verify succeeds when exactly one usable identity exists alongside an untrusted one', () => {
    const { home, keychainPath } = createScratchSigningPaths()
    createExistingKeychainFile(keychainPath)
    const { run } = createSigningFixture({
      identities: [
        { hash: SECOND_USABLE_HASH, status: null },
        { hash: UNTRUSTED_CERT_HASH, status: 'CSSMERR_TP_NOT_TRUSTED' }
      ]
    })
    const result = signing.verifyLocalMacSigningIdentity({
      env: fixtureEnv(keychainPath),
      home,
      platform: 'darwin',
      run
    })
    expect(result.identityHash).toBe(SECOND_USABLE_HASH)
  })

  it('verify fails clearly when the keychain file is missing', () => {
    const { home, keychainPath } = createScratchSigningPaths()
    const { run } = createSigningFixture()
    const error = captureError(() =>
      signing.verifyLocalMacSigningIdentity({
        env: fixtureEnv(keychainPath),
        home,
        platform: 'darwin',
        run
      })
    )
    expect(error?.message).toContain('was not found')
  })

  it('setup fails closed on the live untrusted-identity state instead of printing success', () => {
    const { home, keychainPath } = createScratchSigningPaths()
    createExistingKeychainFile(keychainPath)
    const { state, run } = createSigningFixture({
      identities: [{ hash: UNTRUSTED_CERT_HASH, status: 'CSSMERR_TP_NOT_TRUSTED' }],
      certificateCount: 3
    })
    const error = captureError(() =>
      signing.ensureLocalMacSigningIdentity({
        env: fixtureEnv(keychainPath),
        home,
        platform: 'darwin',
        run
      })
    )
    expect(error?.message).toContain('not trusted for code signing')
    expect(error?.message).toContain(UNTRUSTED_CERT_HASH)
    expect(error?.message).toContain('Keychain Access')
    const subcommands = calledSecuritySubcommands(state)
    expect(subcommands).not.toContain('create-keychain')
    expect(subcommands).not.toContain('import')
    expect(subcommands).not.toContain('delete-identity')
  })

  it('setup recreates the keychain from the stored password record when the file is missing', () => {
    const { home, keychainPath } = createScratchSigningPaths()
    const { state, run } = createSigningFixture()
    const result = signing.ensureLocalMacSigningIdentity({
      env: fixtureEnv(keychainPath),
      home,
      platform: 'darwin',
      run
    })
    expect(result.identityHash).toBe(GENERATED_CERT_HASH)
    const subcommands = calledSecuritySubcommands(state)
    expect(subcommands).toContain('create-keychain')
    expect(subcommands).not.toContain('add-generic-password')
    expect(findSecurityCall(state, 'create-keychain')?.options.input).toContain(FIXTURE_PASSWORD)
    // m1: the password travels over stdin/env, never argv.
    for (const call of state.calls) {
      expect(call.args.join(' ')).not.toContain(FIXTURE_PASSWORD)
    }
    const pkcs12Call = findOpensslCall(state, 'pkcs12')
    expect(pkcs12Call?.args).toContain(`env:${P12_PASSWORD_ENV}`)
    expect(pkcs12Call?.options.env?.[P12_PASSWORD_ENV]).toBe(FIXTURE_PASSWORD)
    // m3: the temporary private key is locked down before the p12 export reads it.
    expect(state.keyModeAtPkcs12).toBe(0o600)
  })

  it('setup generates and stores a new keychain password on a fresh keychain', () => {
    const { home, keychainPath } = createScratchSigningPaths()
    const { state, run } = createSigningFixture({ storedPassword: null })
    const result = signing.ensureLocalMacSigningIdentity({
      env: fixtureEnv(keychainPath),
      home,
      platform: 'darwin',
      run
    })
    expect(result.identityHash).toBe(GENERATED_CERT_HASH)
    const subcommands = calledSecuritySubcommands(state)
    expect(subcommands).toContain('create-keychain')
    expect(subcommands).toContain('add-generic-password')
    expect(subcommands.indexOf('create-keychain')).toBeLessThan(
      subcommands.indexOf('add-generic-password')
    )
    const generatedPassword = state.storedPassword
    expect(typeof generatedPassword).toBe('string')
    expect(findSecurityCall(state, 'create-keychain')?.options.input).toContain(generatedPassword)
    for (const call of state.calls) {
      expect(call.args.join(' ')).not.toContain(generatedPassword)
    }
  })

  it('setup rolls back exactly the just-imported identity when trust registration fails', () => {
    const { home, keychainPath } = createScratchSigningPaths()
    createExistingKeychainFile(keychainPath)
    const { state, run } = createSigningFixture({ trustFails: true })
    const error = captureError(() =>
      signing.ensureLocalMacSigningIdentity({
        env: fixtureEnv(keychainPath),
        home,
        platform: 'darwin',
        run
      })
    )
    expect(error?.message).toContain('rolled back')
    expect(error?.message).toContain(GENERATED_CERT_HASH)
    expect(error?.message).toContain('docs/upstream-sync-playbook.md')
    expect(calledSecuritySubcommands(state)).toContain('import')
    expect(state.deletedIdentityHashes).toEqual([GENERATED_CERT_HASH])
    expect(state.identities).toEqual([])
    expect(state.certificateCount).toBe(0)
  })

  it('setup refuses automatic cleanup when only orphan certificates remain', () => {
    const { home, keychainPath } = createScratchSigningPaths()
    createExistingKeychainFile(keychainPath)
    const { state, run } = createSigningFixture({ certificateCount: 3 })
    const error = captureError(() =>
      signing.ensureLocalMacSigningIdentity({
        env: fixtureEnv(keychainPath),
        home,
        platform: 'darwin',
        run
      })
    )
    expect(error?.message).toContain('no usable signing identity')
    expect(error?.message).toContain('Refusing automatic cleanup')
    expect(error?.message).toContain('docs/upstream-sync-playbook.md')
    const subcommands = calledSecuritySubcommands(state)
    expect(subcommands).not.toContain('delete-identity')
    expect(subcommands).not.toContain('delete-certificate')
    expect(subcommands).not.toContain('import')
    expect(subcommands).not.toContain('create-keychain')
  })

  it('setup refuses to pick between multiple usable identities', () => {
    const { home, keychainPath } = createScratchSigningPaths()
    createExistingKeychainFile(keychainPath)
    const { run } = createSigningFixture({
      identities: [
        { hash: SECOND_USABLE_HASH, status: null },
        { hash: GENERATED_CERT_HASH, status: null }
      ]
    })
    const error = captureError(() =>
      signing.ensureLocalMacSigningIdentity({
        env: fixtureEnv(keychainPath),
        home,
        platform: 'darwin',
        run
      })
    )
    expect(error?.message).toContain('Expected one fixed local macOS signing identity')
    expect(error?.message).toContain('found 2 usable')
    expect(error?.message).toContain('docs/upstream-sync-playbook.md')
  })

  it('includes exit status and stderr details in command failures', () => {
    const error = captureError(() =>
      signing.runCommand(process.execPath, [
        '-e',
        'process.stderr.write("diagnostic detail"); process.exit(3)'
      ])
    )
    expect(error?.message).toBe(
      `macOS local signing command failed: ${process.execPath} -e (exit 3): diagnostic detail`
    )
  })

  it('redacts sensitive values from command failure details', () => {
    const error = captureError(() =>
      signing.runCommand(
        process.execPath,
        ['-e', 'process.stderr.write("leak s3cr3t-value"); process.exit(1)'],
        { sensitiveValues: ['s3cr3t-value'] }
      )
    )
    expect(error?.message).toContain('[redacted]')
    expect(error?.message).not.toContain('s3cr3t-value')
  })
})
