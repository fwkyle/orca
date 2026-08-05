import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { it } from 'vitest'

const projectDir = path.resolve(import.meta.dirname, '../..')

function readProjectFile(relativePath) {
  return readFileSync(path.join(projectDir, relativePath), 'utf8')
}

it('uses fork-only package, builder, helper, and dev-link identities', () => {
  const packageJson = JSON.parse(readProjectFile('package.json'))
  const builderConfig = readProjectFile('config/electron-builder.config.cjs')
  const computerBuild = readProjectFile('config/scripts/build-computer-macos.mjs')
  const notificationBuild = readProjectFile('config/scripts/build-notification-status-macos.mjs')
  const devLinkInstaller = readProjectFile('config/scripts/install-dev-cli.mjs')
  const macCli = readProjectFile('resources/darwin/bin/orca')
  const linuxCli = readProjectFile('resources/linux/bin/orca-ide')
  const windowsCli = readProjectFile('resources/win32/bin/orca.cmd')
  const linuxInstall = readProjectFile('resources/linux/packaging/after-install.sh')
  const linuxRemove = readProjectFile('resources/linux/packaging/after-remove.sh')

  assert.equal(packageJson.name, 'orca-kyle')
  assert.deepEqual(Object.keys(packageJson.bin), ['orca-kyle', 'orca-kyle-dev'])
  assert.match(builderConfig, /const appId = 'com\.chickenbreastky\.orca-kyle'/)
  assert.match(builderConfig, /productName: 'Orca Kyle'/)
  assert.match(builderConfig, /to: 'bin\/orca-kyle'/)
  assert.match(builderConfig, /to: 'bin\/orca-kyle\.cmd'/)
  assert.match(builderConfig, /to: 'bin\/orca-kyle\.exe'/)
  assert.match(computerBuild, /'com\.chickenbreastky\.orca-kyle\.computer-use'/)
  assert.match(notificationBuild, /'com\.chickenbreastky\.orca-kyle\.notification-status'/)
  assert.match(devLinkInstaller, /orca-kyle-dev/)
  assert.doesNotMatch(devLinkInstaller, /\/usr\/local\/bin\/orca-dev/)
  assert.doesNotMatch(devLinkInstaller, /\.local\/bin\/orca-dev/)
  assert.match(macCli, /MacOS\/Orca Kyle/)
  assert.match(linuxCli, /for candidate in orca-kyle 'Orca Kyle'/)
  assert.match(windowsCli, /orca-kyle\.exe/)
  assert.match(linuxInstall, /link="\/usr\/bin\/orca-kyle"/)
  assert.match(linuxRemove, /link="\/usr\/bin\/orca-kyle"/)
})

it(
  'installs only the fork dev CLI link inside an explicit temporary root',
  {
    skip: process.platform === 'win32'
  },
  () => {
    const linkDirectory = mkdtempSync(path.join(tmpdir(), 'orca-kyle-dev-link-'))
    const installerPath = path.join(projectDir, 'config', 'scripts', 'install-dev-cli.mjs')
    const result = spawnSync(process.execPath, [installerPath], {
      encoding: 'utf8',
      env: { ...process.env, ORCA_KYLE_DEV_CLI_LINK_DIR: linkDirectory }
    })

    const forkLink = path.join(linkDirectory, 'orca-kyle-dev')
    assert.equal(result.status, 0, result.stderr)
    assert.equal(lstatSync(forkLink).isSymbolicLink(), true)
    assert.equal(readlinkSync(forkLink), path.join(projectDir, 'config', 'scripts', 'orca-dev.mjs'))
    assert.equal(existsSync(path.join(linkDirectory, 'orca-dev')), false)
    assert.equal(existsSync(path.join(linkDirectory, 'orca')), false)
  }
)

it(
  'rejects a malformed dev CLI link root before installing anything',
  {
    skip: process.platform === 'win32'
  },
  () => {
    const installerPath = path.join(projectDir, 'config', 'scripts', 'install-dev-cli.mjs')
    const result = spawnSync(process.execPath, [installerPath], {
      encoding: 'utf8',
      env: { ...process.env, ORCA_KYLE_DEV_CLI_LINK_DIR: 'relative-link-root' }
    })

    assert.equal(result.status, 1)
    assert.match(result.stderr, /ORCA_KYLE_DEV_CLI_LINK_DIR must be an absolute path/)
  }
)

it(
  'fails when a foreign fork command would otherwise be reported as installed',
  {
    skip: process.platform === 'win32'
  },
  () => {
    const linkDirectory = mkdtempSync(path.join(tmpdir(), 'orca-kyle-dev-foreign-link-'))
    const installerPath = path.join(projectDir, 'config', 'scripts', 'install-dev-cli.mjs')
    writeFileSync(path.join(linkDirectory, 'orca-kyle-dev'), 'foreign command', 'utf8')
    const result = spawnSync(process.execPath, [installerPath], {
      encoding: 'utf8',
      env: { ...process.env, ORCA_KYLE_DEV_CLI_LINK_DIR: linkDirectory }
    })

    assert.equal(result.status, 1)
    assert.match(result.stderr, /exists but is not our symlink/)
  }
)
