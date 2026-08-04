const { execFileSync } = require('node:child_process')
const { createHash, randomBytes } = require('node:crypto')
const { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } = require('node:fs')
const { homedir, tmpdir, userInfo } = require('node:os')
const { dirname, join } = require('node:path')

const LOCAL_MAC_SIGNING_IDENTITY = 'Orca Kyle Local Development Code Signing'
const LOCAL_MAC_SIGNING_KEYCHAIN_ENV = 'ORCA_LOCAL_MAC_SIGNING_KEYCHAIN'
const LOCAL_MAC_SIGNING_MARKER_ENV = 'ORCA_LOCAL_MAC_SIGNING'
const LOCAL_MAC_SIGNING_KEYCHAIN_DIR = join(
  'Library',
  'Application Support',
  'com.chickenbreastky.orca-kyle',
  'local-signing'
)
const LOCAL_MAC_SIGNING_KEYCHAIN_NAME = 'orca-kyle-local-signing.keychain-db'
const LOCAL_MAC_SIGNING_PASSWORD_SERVICE = 'local-signing-keychain-password'
const LOCAL_SIGNING_P12_PASSWORD_ENV = 'ORCA_LOCAL_SIGNING_P12_PASSWORD'

function getLocalMacSigningConfig(env = process.env, home = homedir()) {
  const configuredKeychain = env[LOCAL_MAC_SIGNING_KEYCHAIN_ENV]?.trim()
  const keychainPath =
    configuredKeychain ||
    join(home, LOCAL_MAC_SIGNING_KEYCHAIN_DIR, LOCAL_MAC_SIGNING_KEYCHAIN_NAME)
  if (!keychainPath.startsWith('/')) {
    throw new Error(`${LOCAL_MAC_SIGNING_KEYCHAIN_ENV} must be an absolute path.`)
  }
  return {
    identity: LOCAL_MAC_SIGNING_IDENTITY,
    keychainPath
  }
}

// codesign refuses identities carrying a parenthesized status, so only status-free lines are usable.
function parseIdentityEntries(output, identity = LOCAL_MAC_SIGNING_IDENTITY) {
  const entries = []
  for (const line of output.split('\n')) {
    if (!line.includes(`"${identity}"`)) {
      continue
    }
    const match = line.match(/^\s*\d+\)\s+([0-9A-F]{40})\s+"[^"]*"(?:\s+\(([^)]*)\))?\s*$/i)
    if (match) {
      entries.push({ hash: match[1].toUpperCase(), status: match[2] ?? null })
    }
  }
  return entries
}

function findMatchingIdentityHashes(output, identity = LOCAL_MAC_SIGNING_IDENTITY) {
  return parseIdentityEntries(output, identity)
    .filter((entry) => entry.status === null)
    .map((entry) => entry.hash)
}

function findUntrustedIdentityEntries(output, identity = LOCAL_MAC_SIGNING_IDENTITY) {
  return parseIdentityEntries(output, identity).filter((entry) => entry.status !== null)
}

function localSigningEnvironment(config) {
  return {
    [LOCAL_MAC_SIGNING_MARKER_ENV]: '1',
    CSC_NAME: config.identity,
    CSC_KEYCHAIN: config.keychainPath,
    ORCA_LOCAL_MAC_SIGNING_IDENTITY: config.identity,
    [LOCAL_MAC_SIGNING_KEYCHAIN_ENV]: config.keychainPath
  }
}

function verifyLocalMacSigningIdentity({
  env = process.env,
  home = homedir(),
  platform = process.platform,
  run = runCommand
} = {}) {
  requireMacOS(platform)
  const config = getLocalMacSigningConfig(env, home)
  if (!existsSync(config.keychainPath)) {
    throw missingIdentityError(config)
  }
  const inspection = inspectSigningIdentities(config, run)
  if (inspection.usable.length !== 1) {
    throw identityInspectionError(config, inspection)
  }
  return { ...config, identityHash: inspection.usable[0] }
}

function ensureLocalMacSigningIdentity({
  env = process.env,
  home = homedir(),
  platform = process.platform,
  run = runCommand
} = {}) {
  requireMacOS(platform)
  const config = getLocalMacSigningConfig(env, home)
  mkdirSync(dirname(config.keychainPath), { recursive: true, mode: 0o700 })

  let password = readStoredKeychainPassword(config, home, run)
  const keychainExists = existsSync(config.keychainPath)
  if (keychainExists && password) {
    unlockKeychain(config, password, run)
  }

  const inspection = keychainExists
    ? tryInspectSigningIdentities(config, run)
    : { usable: [], untrusted: [] }
  if (inspection.usable.length === 1) {
    allowCodeSignKeyAccess(config, password, run)
    return { ...config, identityHash: inspection.usable[0] }
  }
  if (inspection.usable.length > 1) {
    throw identityInspectionError(config, inspection)
  }
  if (keychainExists && !password) {
    throw missingPasswordError(config)
  }
  if (inspection.untrusted.length > 0) {
    throw identityInspectionError(config, inspection)
  }
  if (keychainExists && findCertificateCount(config, run) > 0) {
    throw invalidIdentityError(config)
  }
  if (!keychainExists) {
    const generatedPassword = password ?? randomBytes(32).toString('base64')
    runSecurityWithPassword(
      ['create-keychain', '-p', generatedPassword, config.keychainPath],
      generatedPassword,
      run
    )
    if (!password) {
      storeKeychainPassword(config, home, generatedPassword, run)
    }
    password = generatedPassword
    run('/usr/bin/security', ['set-keychain-settings', '-lut', '21600', config.keychainPath])
    unlockKeychain(config, password, run)
  }

  ensureKeychainSearchList(config.keychainPath, run)
  createLocalCertificate(config, password, run)
  allowCodeSignKeyAccess(config, password, run)
  const created = tryInspectSigningIdentities(config, run)
  if (created.usable.length !== 1) {
    throw identityInspectionError(config, created)
  }
  return { ...config, identityHash: created.usable[0] }
}

function inspectSigningIdentities(config, run) {
  const output = run('/usr/bin/security', [
    'find-identity',
    '-v',
    '-p',
    'codesigning',
    config.keychainPath
  ])
  return {
    usable: findMatchingIdentityHashes(output, config.identity),
    untrusted: findUntrustedIdentityEntries(output, config.identity)
  }
}

function tryInspectSigningIdentities(config, run) {
  try {
    return inspectSigningIdentities(config, run)
  } catch {
    return { usable: [], untrusted: [] }
  }
}

function findCertificateCount(config, run) {
  try {
    const output = run('/usr/bin/security', [
      'find-certificate',
      '-a',
      '-c',
      config.identity,
      config.keychainPath
    ])
    return (output.match(/^keychain:/gm) ?? []).length
  } catch {
    return 0
  }
}

function createLocalCertificate(config, password, run) {
  const tempDirectory = mkdtempSync(join(tmpdir(), 'orca-kyle-local-signing-'))
  const opensslConfigPath = join(tempDirectory, 'codesign.cnf')
  const keyPath = join(tempDirectory, 'codesign.key.pem')
  const certificatePath = join(tempDirectory, 'codesign.cert.pem')
  const p12Path = join(tempDirectory, 'codesign.p12')
  try {
    writeFileSync(
      opensslConfigPath,
      `[req]\ndistinguished_name = req_distinguished_name\nx509_extensions = v3_codesign\nprompt = no\n\n[req_distinguished_name]\nCN = ${config.identity}\nO = Orca Kyle Local\n\n[v3_codesign]\nbasicConstraints = critical,CA:false\nkeyUsage = critical,digitalSignature\nextendedKeyUsage = codeSigning\nsubjectKeyIdentifier = hash\nauthorityKeyIdentifier = keyid,issuer\n`,
      { encoding: 'utf8', mode: 0o600 }
    )
    run('/usr/bin/openssl', [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-sha256',
      '-days',
      '3650',
      '-nodes',
      '-keyout',
      keyPath,
      '-out',
      certificatePath,
      '-config',
      opensslConfigPath
    ])
    // Keep the private key unreadable by group/other while it lives in tmpdir.
    chmodSync(keyPath, 0o600)
    run(
      '/usr/bin/openssl',
      [
        'pkcs12',
        '-export',
        '-name',
        config.identity,
        '-inkey',
        keyPath,
        '-in',
        certificatePath,
        '-out',
        p12Path,
        '-passout',
        `env:${LOCAL_SIGNING_P12_PASSWORD_ENV}`
      ],
      {
        env: { ...process.env, [LOCAL_SIGNING_P12_PASSWORD_ENV]: password },
        sensitiveValues: [password]
      }
    )
    const certificateHash = certificateSha1Fingerprint(certificatePath, run)
    runSecurityWithPassword(
      [
        'import',
        p12Path,
        '-k',
        config.keychainPath,
        '-P',
        password,
        '-T',
        '/usr/bin/codesign',
        '-T',
        '/usr/bin/security'
      ],
      password,
      run
    )
    try {
      run(
        '/usr/bin/security',
        [
          'add-trusted-cert',
          '-r',
          'trustRoot',
          '-p',
          'codeSign',
          '-k',
          config.keychainPath,
          certificatePath
        ],
        { timeoutMs: 15000 }
      )
    } catch (trustError) {
      throw trustRegistrationError(config, certificateHash, trustError, run)
    }
  } finally {
    rmSync(tempDirectory, { recursive: true, force: true })
  }
}

// Transaction boundary: a failed trust registration rolls back only the identity this run imported.
function trustRegistrationError(config, certificateHash, trustError, run) {
  try {
    run('/usr/bin/security', ['delete-identity', '-t', '-Z', certificateHash, config.keychainPath])
  } catch (rollbackError) {
    return new Error(
      `macOS did not finish trust registration for the fixed local signing identity, and rollback of the certificate this run imported (SHA-1 ${certificateHash}) also failed: ${rollbackError.message}. Remove exactly that identity manually; see docs/upstream-sync-playbook.md.`
    )
  }
  return new Error(
    `macOS did not finish trust registration for the fixed local signing identity (${trustError.message}); the certificate and key this run imported (SHA-1 ${certificateHash}) were rolled back. Re-run pnpm setup:mac-local-signing in a macOS GUI session and approve the trust prompt; see docs/upstream-sync-playbook.md for the manual procedure.`
  )
}

function certificateSha1Fingerprint(certificatePath, run) {
  const output = run('/usr/bin/openssl', [
    'x509',
    '-in',
    certificatePath,
    '-noout',
    '-fingerprint',
    '-sha1'
  ])
  const match = output.match(/fingerprint=([0-9A-Fa-f:]+)/i)
  if (!match) {
    throw new Error(
      'Could not read the SHA-1 fingerprint of the generated local signing certificate.'
    )
  }
  return match[1].replace(/:/g, '').toUpperCase()
}

function allowCodeSignKeyAccess(config, password, run) {
  if (!password) {
    return
  }
  runSecurityWithPassword(
    [
      'set-key-partition-list',
      '-S',
      'apple-tool:,apple:,codesign:',
      '-s',
      '-k',
      password,
      config.keychainPath
    ],
    password,
    run
  )
}

function ensureKeychainSearchList(keychainPath, run) {
  const existing = run('/usr/bin/security', ['list-keychains', '-d', 'user'])
    .split('\n')
    .map((line) => line.trim().replace(/^"|"$/g, ''))
    .filter(Boolean)
  if (existing.includes(keychainPath)) {
    return
  }
  run('/usr/bin/security', ['list-keychains', '-d', 'user', '-s', keychainPath, ...existing])
}

function readStoredKeychainPassword(config, home, run) {
  try {
    return run('/usr/bin/security', [
      'find-generic-password',
      '-a',
      userInfo().username,
      '-s',
      passwordService(config.keychainPath),
      '-w',
      loginKeychainPath(home, run)
    ]).trim()
  } catch {
    return null
  }
}

function storeKeychainPassword(config, home, password, run) {
  runSecurityWithPassword(
    [
      'add-generic-password',
      '-a',
      userInfo().username,
      '-s',
      passwordService(config.keychainPath),
      '-w',
      password,
      '-U',
      loginKeychainPath(home, run)
    ],
    password,
    run
  )
}

function loginKeychainPath(home, run) {
  const configured = run('/usr/bin/security', ['login-keychain']).trim().replace(/^"|"$/g, '')
  return configured || join(home, 'Library', 'Keychains', 'login.keychain-db')
}

function passwordService(keychainPath) {
  const suffix = createHash('sha256').update(keychainPath).digest('hex').slice(0, 16)
  return `${LOCAL_MAC_SIGNING_PASSWORD_SERVICE}-${suffix}`
}

// Pipe secrets over stdin so they never appear in argv (visible via ps).
function runSecurityWithPassword(args, password, run) {
  return run('/usr/bin/security', ['-i'], {
    input: `${args.map(quoteSecurityInteractiveArg).join(' ')}\n`,
    label: `security ${args[0]}`,
    sensitiveValues: [password]
  })
}

function quoteSecurityInteractiveArg(arg) {
  if (/["\\\n]/.test(arg)) {
    throw new Error(
      'Refusing to pass a value with unsupported characters to security interactive mode.'
    )
  }
  return `"${arg}"`
}

function unlockKeychain(config, password, run) {
  runSecurityWithPassword(['unlock-keychain', '-p', password, config.keychainPath], password, run)
}

function runCommand(command, args, { timeoutMs, input, env, label, sensitiveValues = [] } = {}) {
  try {
    return execFileSync(command, args, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      ...(input === undefined ? {} : { input }),
      ...(env ? { env } : {}),
      ...(timeoutMs ? { timeout: timeoutMs } : {})
    })
  } catch (error) {
    const display = label ?? `${command} ${args[0] ?? ''}`.trim()
    const detail = summarizeCommandError(error, sensitiveValues)
    if (error?.killed || error?.signal === 'SIGTERM') {
      throw new Error(`macOS local signing command timed out: ${display}${detail}`)
    }
    throw new Error(`macOS local signing command failed: ${display}${detail}`)
  }
}

function summarizeCommandError(error, sensitiveValues) {
  const status = Number.isInteger(error?.status) ? ` (exit ${error.status})` : ''
  const stderr = typeof error?.stderr === 'string' ? error.stderr : ''
  const firstLine = stderr
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean)
  const excerpt = firstLine ? redactSensitiveValues(firstLine, sensitiveValues).slice(0, 200) : ''
  return excerpt ? `${status}: ${excerpt}` : status
}

function redactSensitiveValues(text, sensitiveValues) {
  let result = text
  for (const value of sensitiveValues) {
    if (value) {
      result = result.split(value).join('[redacted]')
    }
  }
  return result
}

function requireMacOS(platform) {
  if (platform !== 'darwin') {
    throw new Error('Orca Kyle local macOS signing requires macOS.')
  }
}

function missingIdentityError(config) {
  return new Error(
    `Fixed local macOS signing identity "${config.identity}" was not found in ${config.keychainPath}; refusing automatic keychain selection. Run pnpm setup:mac-local-signing.`
  )
}

function missingPasswordError(config) {
  return new Error(
    `The fixed local macOS signing keychain exists but its Keychain password record is missing: ${config.keychainPath}. Refusing automatic keychain selection; run pnpm setup:mac-local-signing with the original user Keychain available.`
  )
}

function invalidIdentityError(config) {
  return new Error(
    `The fixed local macOS signing keychain contains certificates named "${config.identity}" but no usable signing identity: ${config.keychainPath}. Refusing automatic cleanup of existing items; follow the manual recovery procedure in docs/upstream-sync-playbook.md.`
  )
}

function identityInspectionError(config, inspection) {
  if (inspection.usable.length > 1) {
    return new Error(
      `Expected one fixed local macOS signing identity in ${config.keychainPath}, found ${inspection.usable.length} usable (SHA-1: ${inspection.usable.join(', ')}); refusing automatic selection. Follow the manual recovery procedure in docs/upstream-sync-playbook.md.`
    )
  }
  if (inspection.untrusted.length > 0) {
    return untrustedIdentityError(config, inspection.untrusted)
  }
  return missingIdentityError(config)
}

function untrustedIdentityError(config, untrusted) {
  const detail = untrusted.map((entry) => `SHA-1 ${entry.hash} (${entry.status})`).join(', ')
  if (untrusted.length === 1) {
    return new Error(
      `Fixed local macOS signing identity "${config.identity}" in ${config.keychainPath} is not trusted for code signing (${detail}), so codesign cannot use it. Open Keychain Access, double-click the certificate with SHA-1 ${untrusted[0].hash} in the dedicated keychain, expand Trust, and set "When using this certificate" to "Always Trust"; then run pnpm setup:mac-local-signing again. See docs/upstream-sync-playbook.md for the manual procedure.`
    )
  }
  return new Error(
    `Found ${untrusted.length} untrusted signing identities named "${config.identity}" in ${config.keychainPath} (${detail}); refusing automatic selection. Approve exactly one in Keychain Access or follow the manual recovery procedure in docs/upstream-sync-playbook.md.`
  )
}

function runCli() {
  try {
    const result = process.argv.includes('--setup')
      ? ensureLocalMacSigningIdentity()
      : verifyLocalMacSigningIdentity()
    console.log(`[macos-local-signing] identity: ${result.identity}`)
    console.log(`[macos-local-signing] identity hash: ${result.identityHash}`)
    console.log(`[macos-local-signing] keychain: ${result.keychainPath}`)
  } catch (error) {
    console.error(`[macos-local-signing] ${error.message}`)
    process.exitCode = 1
  }
}

if (require.main === module) {
  runCli()
}

module.exports = {
  LOCAL_MAC_SIGNING_IDENTITY,
  LOCAL_MAC_SIGNING_KEYCHAIN_ENV,
  LOCAL_MAC_SIGNING_MARKER_ENV,
  ensureLocalMacSigningIdentity,
  findMatchingIdentityHashes,
  findUntrustedIdentityEntries,
  getLocalMacSigningConfig,
  localSigningEnvironment,
  runCommand,
  verifyLocalMacSigningIdentity
}
