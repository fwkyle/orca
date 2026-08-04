import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const nodeChildProcess = require('node:child_process')
const nodeFileSystem = require('node:fs')

export const ELECTRON_BUILDER_CONFIG_PATH = require.resolve('../electron-builder.config.cjs')
export const FIXTURE_KEYCHAIN_PATH = '/private/tmp/orca-kyle-test-dedicated.keychain-db'
export const FIXTURE_IDENTITY_HASH = 'A32F4023600BFDC1E7684C97048FEA9ED87A0A79'

const LOCAL_IDENTITY = 'Orca Kyle Local Development Code Signing'
const DEFAULT_KEYCHAIN_SUFFIX = 'orca-kyle-local-signing.keychain-db'
const BUILD_ENVIRONMENT_KEYS = [
  'ORCA_LOCAL_MAC_SIGNING_KEYCHAIN',
  'CSC_NAME',
  'ORCA_LOCAL_MAC_SIGNING_IDENTITY',
  'ORCA_MAC_RELEASE',
  'ORCA_MAC_HOURLY',
  'ORCA_MAC_ADHOC',
  'ORCA_HOURLY_BUILD_VERSION',
  'ORCA_ADHOC_BUILD_VERSION',
  'ORCA_LOCAL_BUILD_VERSION',
  'ORCA_LINUX_ARM64_RELEASE'
]

export function installElectronBuilderConfigTestFixture({
  env = {},
  keychainPath = FIXTURE_KEYCHAIN_PATH,
  identityOutput = renderIdentityOutput(FIXTURE_IDENTITY_HASH)
} = {}) {
  if (process.platform !== 'darwin') {
    throw new Error('This test must execute the real macOS local-signing branch on darwin.')
  }

  const previousModule = require.cache[ELECTRON_BUILDER_CONFIG_PATH]
  const previousExecFileSync = Object.getOwnPropertyDescriptor(nodeChildProcess, 'execFileSync')
  const previousExistsSync = Object.getOwnPropertyDescriptor(nodeFileSystem, 'existsSync')
  const previousEnvironment = { ...process.env }
  const securityCalls = []
  const existsCalls = []
  let restored = false

  for (const key of BUILD_ENVIRONMENT_KEYS) {
    delete process.env[key]
  }
  Object.assign(process.env, env)
  process.env.ORCA_LOCAL_MAC_SIGNING_KEYCHAIN = keychainPath

  nodeFileSystem.existsSync = (candidatePath) => {
    existsCalls.push(candidatePath)
    const normalizedPath = String(candidatePath)
    if (normalizedPath === keychainPath) {
      return true
    }
    if (normalizedPath.endsWith(DEFAULT_KEYCHAIN_SUFFIX)) {
      throw new Error(`Unexpected default local signing keychain path: ${normalizedPath}`)
    }
    return previousExistsSync.value(candidatePath)
  }
  nodeChildProcess.execFileSync = (command, args, options) => {
    if (command === '/usr/bin/security' || command === 'security') {
      const call = { command, args: [...args], options }
      securityCalls.push(call)
      if (
        command !== '/usr/bin/security' ||
        args.length !== 5 ||
        args[0] !== 'find-identity' ||
        args[1] !== '-v' ||
        args[2] !== '-p' ||
        args[3] !== 'codesigning' ||
        args[4] !== keychainPath
      ) {
        throw new Error(`Unexpected uncaptured security call: ${command} ${args.join(' ')}`)
      }
      return identityOutput
    }
    return previousExecFileSync.value(command, args, options)
  }
  delete require.cache[ELECTRON_BUILDER_CONFIG_PATH]

  const restore = () => {
    if (restored) {
      return
    }
    delete require.cache[ELECTRON_BUILDER_CONFIG_PATH]
    restoreCacheEntry(previousModule)
    restoreProperty(nodeChildProcess, 'execFileSync', previousExecFileSync)
    restoreProperty(nodeFileSystem, 'existsSync', previousExistsSync)
    for (const key of Object.keys(process.env)) {
      delete process.env[key]
    }
    Object.assign(process.env, previousEnvironment)
    restored = true
  }

  return {
    keychainPath,
    securityCalls,
    existsCalls,
    requireConfig: () => require(ELECTRON_BUILDER_CONFIG_PATH),
    restore,
    isRestored: () =>
      restored &&
      hasOriginalState(
        previousModule,
        previousExecFileSync,
        previousExistsSync,
        previousEnvironment
      )
  }
}

export function withElectronBuilderConfigTestFixture(assert, options) {
  const fixture = installElectronBuilderConfigTestFixture(options)
  try {
    return assert(fixture)
  } finally {
    fixture.restore()
  }
}

function renderIdentityOutput(identityHash) {
  return `  1) ${identityHash} "${LOCAL_IDENTITY}"\n     1 valid identities found`
}

function restoreCacheEntry(previousModule) {
  if (previousModule) {
    require.cache[ELECTRON_BUILDER_CONFIG_PATH] = previousModule
  }
}

function restoreProperty(target, property, descriptor) {
  if (descriptor) {
    Object.defineProperty(target, property, descriptor)
  } else {
    delete target[property]
  }
}

function hasOriginalState(previousModule, previousExecFileSync, previousExistsSync, environment) {
  return (
    require.cache[ELECTRON_BUILDER_CONFIG_PATH] === previousModule &&
    sameDescriptor(
      Object.getOwnPropertyDescriptor(nodeChildProcess, 'execFileSync'),
      previousExecFileSync
    ) &&
    sameDescriptor(
      Object.getOwnPropertyDescriptor(nodeFileSystem, 'existsSync'),
      previousExistsSync
    ) &&
    sameEnvironment(environment)
  )
}

function sameDescriptor(actual, expected) {
  if (!actual || !expected) {
    return actual === expected
  }
  return (
    actual.value === expected.value &&
    actual.get === expected.get &&
    actual.set === expected.set &&
    actual.enumerable === expected.enumerable &&
    actual.configurable === expected.configurable &&
    actual.writable === expected.writable
  )
}

function sameEnvironment(expected) {
  const actualKeys = Object.keys(process.env)
  const expectedKeys = Object.keys(expected)
  if (actualKeys.length !== expectedKeys.length) {
    return false
  }
  return expectedKeys.every((key) => process.env[key] === expected[key])
}
