// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installWebWindowShortcuts, onWebWindowShortcut } from './web-window-shortcuts'

function press(init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { cancelable: true, bubbles: true, ...init })
  window.dispatchEvent(event)
  return event
}

const CTRL_P = { key: 'p', code: 'KeyP', ctrlKey: true }

describe('web window shortcuts', () => {
  let dispose: () => void

  beforeEach(() => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Linux')
    dispose = installWebWindowShortcuts()
  })

  afterEach(() => {
    dispose()
    vi.restoreAllMocks()
  })

  it('runs the action and takes the key from the browser', () => {
    const openQuickOpen = vi.fn()
    const unsubscribe = onWebWindowShortcut('openQuickOpen', openQuickOpen)
    const event = press(CTRL_P)
    unsubscribe()
    expect(openQuickOpen).toHaveBeenCalledTimes(1)
    expect(event.defaultPrevented).toBe(true)
  })

  it('leaves the key to the browser until the app is listening', () => {
    expect(press(CTRL_P).defaultPrevented).toBe(false)
  })

  it('leaves plain typing alone', () => {
    const openQuickOpen = vi.fn()
    const unsubscribe = onWebWindowShortcut('openQuickOpen', openQuickOpen)
    const event = press({ key: 'p', code: 'KeyP' })
    unsubscribe()
    expect(openQuickOpen).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(false)
  })
})
