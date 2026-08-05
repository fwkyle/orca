type ParsedVersion = {
  core: [number, number, number]
  prerelease: string[]
}

export type LocalBuildMetadata = {
  baseVersion: string
  timestampMs: number
  commit: string
}

const LOCAL_BUILD_VERSION =
  /^(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:-|\.)local\.(\d+)\.([0-9A-Za-z-]+)$/

function parseVersion(value: string): ParsedVersion | null {
  const normalized = value.trim().replace(/^v/i, '')
  const match = normalized.match(
    /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-.]+))?(?:\+([0-9A-Za-z-.]+))?$/
  )
  if (!match) {
    return null
  }

  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4]?.split('.') ?? []
  }
}

export function isValidAppVersion(value: string): boolean {
  return parseVersion(value) !== null
}

export function isPrereleaseAppVersion(value: string): boolean {
  const parsed = parseVersion(value)
  return parsed !== null && parsed.prerelease.length > 0
}

export function isPerfPrereleaseAppVersion(value: string): boolean {
  const parsed = parseVersion(value)
  return parsed?.prerelease.some((identifier) => identifier.toLowerCase() === 'perf') ?? false
}

/** Reads the timestamp and commit that local package builds append to app.getVersion(). */
export function parseLocalBuildMetadata(value: string): LocalBuildMetadata | null {
  const normalized = value.trim().replace(/^v/i, '')
  const match = normalized.match(LOCAL_BUILD_VERSION)
  if (!match || !isValidAppVersion(match[1])) {
    return null
  }

  const timestampMs = Number(match[2])
  if (
    !Number.isSafeInteger(timestampMs) ||
    timestampMs <= 0 ||
    Number.isNaN(new Date(timestampMs).getTime())
  ) {
    return null
  }

  return {
    baseVersion: match[1],
    timestampMs,
    commit: match[3]
  }
}

function compareIdentifiers(left: string, right: string): number {
  const leftNumeric = /^\d+$/.test(left)
  const rightNumeric = /^\d+$/.test(right)

  if (leftNumeric && rightNumeric) {
    return Number(left) - Number(right)
  }
  if (leftNumeric) {
    return -1
  }
  if (rightNumeric) {
    return 1
  }
  return left.localeCompare(right)
}

/** Returns negative if left < right, 0 if equal, positive if left > right. */
export function compareAppVersions(left: string, right: string): number {
  const leftVersion = parseVersion(left)
  const rightVersion = parseVersion(right)
  if (!leftVersion || !rightVersion) {
    return 0
  }

  for (let index = 0; index < leftVersion.core.length; index += 1) {
    const leftPart = leftVersion.core[index]
    const rightPart = rightVersion.core[index]
    if (leftPart !== rightPart) {
      return leftPart - rightPart
    }
  }

  const leftPrerelease = leftVersion.prerelease
  const rightPrerelease = rightVersion.prerelease
  if (leftPrerelease.length === 0 && rightPrerelease.length === 0) {
    return 0
  }
  if (leftPrerelease.length === 0) {
    return 1
  }
  if (rightPrerelease.length === 0) {
    return -1
  }

  for (let index = 0; index < Math.max(leftPrerelease.length, rightPrerelease.length); index += 1) {
    const leftPart = leftPrerelease[index]
    const rightPart = rightPrerelease[index]
    if (leftPart === undefined) {
      return -1
    }
    if (rightPart === undefined) {
      return 1
    }

    const comparison = compareIdentifiers(leftPart, rightPart)
    if (comparison !== 0) {
      return comparison
    }
  }

  return 0
}
