import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { withElectronBuilderConfigTestFixture } from './electron-builder-config-test-fixture.mjs'
import signing from './macos-local-signing.cjs'

const GENERATED_CERT_HASH = '5EE6B7B408C8E4D21F169376A37543BB2B9F0001'
const UNTRUSTED_CERT_HASH = 'A32F4023600BFDC1E7684C97048FEA9ED87A0A79'
const SECOND_USABLE_HASH = '0123456789ABCDEF0123456789ABCDEF01234567'
const ORPHAN_CERT_HASHES = [
  '280B3561727FC9A13A34EE242CE46D9E566A340E',
  'A09FB6FA48236D6177D641EAD358E4C9480244C0',
  'DE0509277BEC9AB515D2BB3CC9004CBFC6A6BC77'
]
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
        identityHash: UNTRUSTED_CERT_HASH,
        keychainPath: '/private/tmp/orca-local.keychain-db'
      })
    ).toEqual({
      ORCA_LOCAL_MAC_SIGNING: '1',
      CSC_NAME: UNTRUSTED_CERT_HASH,
      CSC_KEYCHAIN: '/private/tmp/orca-local.keychain-db',
      ORCA_LOCAL_MAC_SIGNING_IDENTITY: UNTRUSTED_CERT_HASH,
      ORCA_LOCAL_MAC_SIGNING_KEYCHAIN: '/private/tmp/orca-local.keychain-db'
    })
  })

  it('pins the non-release builder to the fixed identity without notarization', () => {
    withElectronBuilderConfigTestFixture(
      ({ requireConfig, securityCalls, existsCalls, keychainPath }) => {
        const config = requireConfig()
        expect(securityCalls).toHaveLength(0)
        expect(existsCalls).not.toContain(keychainPath)
        expect(config.mac.identity).toMatch(/^[0-9A-F]{40}$/)
        expect(config.mac.notarize).toBe(false)
        expect(securityCalls).toHaveLength(1)
      }
    )
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

  // Fixture certs carry their SHA-1 in the PEM body so the fake x509 can fingerprint them.
  function hashFromFixtureCertContent(content) {
    return content.match(/[0-9A-F]{40}/)?.[0] ?? GENERATED_CERT_HASH
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
        return ''
      case 'set-key-partition-list': {
        if (state.partitionFails) {
          throw fixtureCommandError(
            'security set-key-partition-list',
            1,
            'The user name or passphrase you entered is not correct.'
          )
        }
        return ''
      }
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
      case 'find-certificate': {
        if (rest.includes('-p')) {
          return state.certificates
            .map((hash) => `-----BEGIN CERTIFICATE-----\n${hash}\n-----END CERTIFICATE-----`)
            .join('\n')
        }
        return state.certificates
          .map(() => 'keychain: "/Users/fixture/Library/Keychains/dedicated.keychain-db"')
          .join('\n')
      }
      case 'import':
        state.certificates.push(GENERATED_CERT_HASH)
        state.identities.push({ hash: GENERATED_CERT_HASH, status: 'CSSMERR_TP_NOT_TRUSTED' })
        return ''
      case 'add-trusted-cert': {
        if (state.trustFails) {
          throw fixtureCommandError(
            'security add-trusted-cert',
            1,
            'User interaction is not allowed'
          )
        }
        const content = readFileSync(rest.at(-1), 'utf8')
        state.trustedCertContents.push(content)
        const trustedHash = hashFromFixtureCertContent(content)
        for (const identity of state.identities) {
          if (identity.hash === trustedHash) {
            identity.status = null
          }
        }
        return ''
      }
      case 'delete-identity': {
        const hash = rest[rest.indexOf('-Z') + 1]
        state.deletedIdentityHashes.push(hash)
        state.identities = state.identities.filter((identity) => identity.hash !== hash)
        state.certificates = state.certificates.filter((certificate) => certificate !== hash)
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
      case 'x509': {
        const content = readFileSync(rest[rest.indexOf('-in') + 1], 'utf8')
        return `SHA1 Fingerprint=${hashFromFixtureCertContent(content).match(/../g).join(':')}\n`
      }
      default:
        throw new Error(`Unexpected openssl subcommand: ${subcommand}`)
    }
  }

  function createSigningFixture(overrides = {}) {
    const state = {
      storedPassword: FIXTURE_PASSWORD,
      identities: [],
      certificates: [],
      searchList: [],
      trustFails: false,
      partitionFails: false,
      deletedIdentityHashes: [],
      trustedCertContents: [],
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

  function ensureWithFixture(run, keychainPath, home) {
    return signing.ensureLocalMacSigningIdentity({
      env: fixtureEnv(keychainPath),
      home,
      platform: 'darwin',
      run
    })
  }

  function verifyWithFixture(run, keychainPath, home) {
    return signing.verifyLocalMacSigningIdentity({
      env: fixtureEnv(keychainPath),
      home,
      platform: 'darwin',
      run
    })
  }

  function searchListWriteCalls(state) {
    return state.calls.filter(
      (call) =>
        call.command === '/usr/bin/security' &&
        call.args[0] === 'list-keychains' &&
        call.args.includes('-s')
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

  it('verify fails closed with hash and setup guidance when the identity is untrusted', () => {
    const { home, keychainPath } = createScratchSigningPaths()
    createExistingKeychainFile(keychainPath)
    const { run } = createSigningFixture({
      identities: [{ hash: UNTRUSTED_CERT_HASH, status: 'CSSMERR_TP_NOT_TRUSTED' }]
    })
    const error = captureError(() => verifyWithFixture(run, keychainPath, home))
    expect(error?.message).toContain('not trusted for code signing')
    expect(error?.message).toContain(UNTRUSTED_CERT_HASH)
    expect(error?.message).toContain('CSSMERR_TP_NOT_TRUSTED')
    expect(error?.message).toContain('pnpm setup:mac-local-signing')
    expect(error?.message).toContain('administrator password prompt')
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
    const result = verifyWithFixture(run, keychainPath, home)
    expect(result.identityHash).toBe(SECOND_USABLE_HASH)
  })

  it('verify fails clearly when the keychain file is missing', () => {
    const { home, keychainPath } = createScratchSigningPaths()
    const { run } = createSigningFixture()
    const error = captureError(() => verifyWithFixture(run, keychainPath, home))
    expect(error?.message).toContain('was not found')
  })

  it('setup recovers an existing untrusted identity by trusting exactly its hash-matching certificate', () => {
    const { home, keychainPath } = createScratchSigningPaths()
    createExistingKeychainFile(keychainPath)
    const { state, run } = createSigningFixture({
      identities: [{ hash: UNTRUSTED_CERT_HASH, status: 'CSSMERR_TP_NOT_TRUSTED' }],
      // Orphan certs come first so the loop must skip them to reach the identity cert.
      certificates: [...ORPHAN_CERT_HASHES, UNTRUSTED_CERT_HASH]
    })
    const result = ensureWithFixture(run, keychainPath, home)
    expect(result.identityHash).toBe(UNTRUSTED_CERT_HASH)
    const trustCall = findSecurityCall(state, 'add-trusted-cert')
    expect(trustCall?.args.slice(0, -1)).toEqual([
      'add-trusted-cert',
      '-d',
      '-r',
      'trustRoot',
      '-p',
      'codeSign',
      '-k',
      keychainPath
    ])
    expect(state.trustedCertContents).toHaveLength(1)
    expect(state.trustedCertContents[0]).toContain(UNTRUSTED_CERT_HASH)
    for (const orphanHash of ORPHAN_CERT_HASHES) {
      expect(state.trustedCertContents[0]).not.toContain(orphanHash)
    }
    const subcommands = calledSecuritySubcommands(state)
    expect(subcommands).not.toContain('import')
    expect(subcommands).not.toContain('create-keychain')
    expect(subcommands).not.toContain('delete-identity')
    expect(subcommands).not.toContain('delete-certificate')
    expect(state.certificates).toHaveLength(4)
    expect(findSecurityCall(state, 'set-key-partition-list')?.options.input).toContain(
      'apple-tool:,apple:,codesign:'
    )
  })

  it('setup fails closed without deleting anything when automatic trust of an existing identity fails', () => {
    const { home, keychainPath } = createScratchSigningPaths()
    createExistingKeychainFile(keychainPath)
    const { state, run } = createSigningFixture({
      identities: [{ hash: UNTRUSTED_CERT_HASH, status: 'CSSMERR_TP_NOT_TRUSTED' }],
      certificates: [...ORPHAN_CERT_HASHES, UNTRUSTED_CERT_HASH],
      trustFails: true
    })
    const error = captureError(() => ensureWithFixture(run, keychainPath, home))
    expect(error?.message).toContain('did not finish automatic trust registration')
    expect(error?.message).toContain(UNTRUSTED_CERT_HASH)
    expect(error?.message).toContain('administrator password prompt')
    const subcommands = calledSecuritySubcommands(state)
    expect(subcommands).not.toContain('delete-identity')
    expect(subcommands).not.toContain('delete-certificate')
    expect(subcommands).not.toContain('import')
    expect(state.certificates).toHaveLength(4)
    expect(state.identities[0]?.status).toBe('CSSMERR_TP_NOT_TRUSTED')
  })

  it('setup refuses to select among multiple untrusted identities', () => {
    const { home, keychainPath } = createScratchSigningPaths()
    createExistingKeychainFile(keychainPath)
    const { state, run } = createSigningFixture({
      identities: [
        { hash: UNTRUSTED_CERT_HASH, status: 'CSSMERR_TP_NOT_TRUSTED' },
        { hash: GENERATED_CERT_HASH, status: 'CSSMERR_TP_NOT_TRUSTED' }
      ],
      certificates: [UNTRUSTED_CERT_HASH, GENERATED_CERT_HASH]
    })
    const error = captureError(() => ensureWithFixture(run, keychainPath, home))
    expect(error?.message).toContain('Found 2 untrusted signing identities')
    expect(error?.message).toContain('refusing automatic selection')
    expect(calledSecuritySubcommands(state)).not.toContain('add-trusted-cert')
  })

  it('setup recreates the keychain from the stored password record when the file is missing', () => {
    const { home, keychainPath } = createScratchSigningPaths()
    const { state, run } = createSigningFixture()
    const result = ensureWithFixture(run, keychainPath, home)
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
    expect(subcommands).toContain('set-key-partition-list')
  })

  it('setup registers the dedicated keychain in the search list preserving existing entries', () => {
    const { home, keychainPath } = createScratchSigningPaths()
    createExistingKeychainFile(keychainPath)
    const existingKeychain = '/Users/fixture/Library/Keychains/login.keychain-db'
    const { state, run } = createSigningFixture({
      identities: [{ hash: SECOND_USABLE_HASH, status: null }],
      certificates: [SECOND_USABLE_HASH],
      searchList: [existingKeychain]
    })
    const result = ensureWithFixture(run, keychainPath, home)
    expect(result.identityHash).toBe(SECOND_USABLE_HASH)
    const writeCalls = searchListWriteCalls(state)
    expect(writeCalls).toHaveLength(1)
    expect(writeCalls[0]?.args).toEqual([
      'list-keychains',
      '-d',
      'user',
      '-s',
      keychainPath,
      existingKeychain
    ])
  })

  it('setup leaves the search list untouched when the keychain is already registered', () => {
    const { home, keychainPath } = createScratchSigningPaths()
    createExistingKeychainFile(keychainPath)
    const existingKeychain = '/Users/fixture/Library/Keychains/login.keychain-db'
    const { state, run } = createSigningFixture({
      identities: [{ hash: SECOND_USABLE_HASH, status: null }],
      certificates: [SECOND_USABLE_HASH],
      searchList: [keychainPath, existingKeychain]
    })
    const result = ensureWithFixture(run, keychainPath, home)
    expect(result.identityHash).toBe(SECOND_USABLE_HASH)
    const writeCalls = searchListWriteCalls(state)
    expect(writeCalls).toHaveLength(0)
    expect(state.searchList).toEqual([keychainPath, existingKeychain])
  })

  it('setup generates and stores a new keychain password on a fresh keychain', () => {
    const { home, keychainPath } = createScratchSigningPaths()
    const { state, run } = createSigningFixture({ storedPassword: null })
    const result = ensureWithFixture(run, keychainPath, home)
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
    const error = captureError(() => ensureWithFixture(run, keychainPath, home))
    expect(error?.message).toContain('rolled back')
    expect(error?.message).toContain(GENERATED_CERT_HASH)
    expect(error?.message).toContain('docs/upstream-sync-playbook.md')
    expect(calledSecuritySubcommands(state)).toContain('import')
    expect(findSecurityCall(state, 'add-trusted-cert')?.args).toContain('-d')
    expect(state.deletedIdentityHashes).toEqual([GENERATED_CERT_HASH])
    expect(state.identities).toEqual([])
    expect(state.certificates).toEqual([])
  })

  it('setup rolls back the just-imported identity when key partition list registration fails', () => {
    const { home, keychainPath } = createScratchSigningPaths()
    createExistingKeychainFile(keychainPath)
    const { state, run } = createSigningFixture({ partitionFails: true })
    const error = captureError(() => ensureWithFixture(run, keychainPath, home))
    expect(error?.message).toContain('key partition list registration')
    expect(error?.message).toContain('rolled back')
    expect(error?.message).toContain(GENERATED_CERT_HASH)
    expect(state.deletedIdentityHashes).toEqual([GENERATED_CERT_HASH])
    expect(state.identities).toEqual([])
    expect(state.certificates).toEqual([])
  })

  it('setup refuses automatic cleanup when only orphan certificates remain', () => {
    const { home, keychainPath } = createScratchSigningPaths()
    createExistingKeychainFile(keychainPath)
    const { state, run } = createSigningFixture({ certificates: [...ORPHAN_CERT_HASHES] })
    const error = captureError(() => ensureWithFixture(run, keychainPath, home))
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
    const error = captureError(() => ensureWithFixture(run, keychainPath, home))
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
