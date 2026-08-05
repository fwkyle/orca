// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import SidebarBuildInfo, { formatLocalBuildTimestamp } from './SidebarBuildInfo'

const originalApi = window.api

function mockAppVersion(version: string): void {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { updater: { getVersion: vi.fn().mockResolvedValue(version) } }
  })
}

describe('SidebarBuildInfo', () => {
  beforeEach(() => {
    mockAppVersion('1.4.159-local.1750000000123.abcdef123456')
  })

  afterEach(() => {
    cleanup()
    Object.defineProperty(window, 'api', { configurable: true, value: originalApi })
    vi.restoreAllMocks()
  })

  it('shows local build time and a shortened commit from appVersion', async () => {
    const view = render(<SidebarBuildInfo />)
    const info = await waitFor(() => view.getByTestId('sidebar-build-info'))

    expect(info).toHaveTextContent('Version 1.4.159')
    expect(info).toHaveTextContent(
      `Local build · ${formatLocalBuildTimestamp(1750000000123)} · commit abcdef1`
    )
    expect(info).toHaveAttribute('data-app-version', '1.4.159-local.1750000000123.abcdef123456')
  })

  it('keeps a readable version label when the build has no local metadata', async () => {
    mockAppVersion('1.4.159')
    const view = render(<SidebarBuildInfo />)
    const info = await waitFor(() => view.getByTestId('sidebar-build-info'))

    expect(info).toHaveTextContent('Version 1.4.159')
    expect(info).not.toHaveTextContent('Local build')
  })
})
