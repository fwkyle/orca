import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import localSigning from './macos-local-signing.cjs'

export function createLocalBuildVersion(baseVersion, timestamp, commit) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(baseVersion)) {
    throw new Error(`Package version is not valid semver: ${baseVersion}`)
  }
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0) {
    throw new Error('Local build timestamp is invalid.')
  }
  const sanitizedCommit = commit.replace(/[^0-9A-Za-z-]/g, '').slice(0, 12)
  if (!sanitizedCommit) {
    throw new Error('Git commit identity is empty.')
  }
  const suffix = `local.${timestamp}.${sanitizedCommit}`
  return baseVersion.includes('-') ? `${baseVersion}.${suffix}` : `${baseVersion}-${suffix}`
}

export function getLocalBuildIdentity() {
  const packageJson = JSON.parse(readFileSync(resolve('package.json'), 'utf8'))
  const commit = execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], {
    encoding: 'utf8'
  }).trim()
  return {
    commit,
    version: createLocalBuildVersion(packageJson.version, Date.now(), commit)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  try {
    if (process.platform !== 'darwin') {
      throw new Error('pnpm build:mac local signing requires macOS.')
    }
    if (
      process.env.ORCA_MAC_RELEASE === '1' ||
      process.env.ORCA_MAC_HOURLY === '1' ||
      process.env.ORCA_MAC_ADHOC === '1'
    ) {
      throw new Error('Local macOS build cannot run with release signing environment variables.')
    }
    const signing = localSigning.verifyLocalMacSigningIdentity()
    const identity = getLocalBuildIdentity()
    console.log(`[build:mac] local update version ${identity.version}`)
    console.log(`[build:mac] local signing identity ${signing.identity}`)
    execFileSync(
      process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
      ['exec', 'electron-builder', '--config', 'config/electron-builder.config.cjs', '--mac'],
      {
        env: {
          ...process.env,
          ...localSigning.localSigningEnvironment(signing),
          ORCA_BUILD_COMMIT: identity.commit,
          ORCA_LOCAL_BUILD_VERSION: identity.version
        },
        stdio: 'inherit'
      }
    )
  } catch (error) {
    console.error(`[build:mac] ${error.message}`)
    process.exitCode = 1
  }
}
