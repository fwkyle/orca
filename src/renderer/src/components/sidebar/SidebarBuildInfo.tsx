import React, { useEffect, useState } from 'react'
import { translate } from '@/i18n/i18n'
import { parseLocalBuildMetadata } from '../../../../shared/app-version'

export function formatLocalBuildTimestamp(timestampMs: number): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short'
  }).format(new Date(timestampMs))
}

function SidebarBuildInfo(): React.JSX.Element | null {
  const [appVersion, setAppVersion] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const getVersion = window.api?.updater?.getVersion
    if (!getVersion) {
      return
    }

    void getVersion()
      .then((version) => {
        if (!cancelled && typeof version === 'string' && version.trim()) {
          setAppVersion(version)
        }
      })
      .catch(() => {})

    return () => {
      cancelled = true
    }
  }, [])

  if (!appVersion) {
    return null
  }

  const localBuild = parseLocalBuildMetadata(appVersion)
  const versionLabel = translate(
    'auto.components.sidebar.SidebarBuildInfo.version',
    'Version {{value0}}',
    { value0: localBuild?.baseVersion ?? appVersion }
  )
  const detailLabel = localBuild
    ? translate(
        'auto.components.sidebar.SidebarBuildInfo.localBuild',
        'Local build · {{value0}} · commit {{value1}}',
        {
          value0: formatLocalBuildTimestamp(localBuild.timestampMs),
          value1: localBuild.commit.slice(0, 7)
        }
      )
    : null

  return (
    <div
      data-testid="sidebar-build-info"
      data-app-version={appVersion}
      className="min-w-0 shrink-0 border-t border-worktree-sidebar-border px-2 py-1.5"
      title={appVersion}
      aria-label={detailLabel ? `${versionLabel} · ${detailLabel}` : versionLabel}
    >
      <div className="truncate font-mono text-[11px] leading-4 text-worktree-sidebar-foreground/65">
        {versionLabel}
      </div>
      {detailLabel ? (
        <div className="truncate text-[11px] leading-4 text-worktree-sidebar-foreground/50">
          {detailLabel}
        </div>
      ) : null}
    </div>
  )
}

export default React.memo(SidebarBuildInfo)
