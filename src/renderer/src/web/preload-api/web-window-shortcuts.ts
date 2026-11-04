import {
  normalizeTerminalShortcutPolicy,
  type KeybindingActionId,
  type KeybindingMatchOptions,
  type KeybindingOverrides
} from '../../../../shared/keybindings'
import {
  getWindowShortcutActionId,
  matchesRecentTabSwitcherChord,
  resolveWindowShortcutAction,
  windowShortcutActionCapturesTerminal,
  type WindowShortcutAction
} from '../../../../shared/window-shortcut-policy'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { createWebKeybindingsApi, getWebKeybindingSnapshot } from './web-keybindings-api'
import { SETTINGS_STORAGE_KEY, getBrowserPlatform, readJson } from './web-storage'

type ActionType = WindowShortcutAction['type']
type ActionOf<T extends ActionType> = Extract<WindowShortcutAction, { type: T }>

const listeners = new Map<ActionType, Set<(action: WindowShortcutAction) => void>>()
const captureListeners = new Set<(payload: { actionId: KeybindingActionId }) => void>()
const focus = {
  terminalInput: false,
  floatingTerminalInput: false,
  floatingPanel: false,
  markdownEditor: false,
  shortcutRecorder: false
}

function isActionOfType<T extends ActionType>(
  action: WindowShortcutAction,
  type: T
): action is ActionOf<T> {
  return action.type === type
}

export function onWebWindowShortcut<T extends ActionType>(
  type: T,
  listener: (action: ActionOf<T>) => void
): () => void {
  const wrapped = (action: WindowShortcutAction): void => {
    if (isActionOfType(action, type)) {
      listener(action)
    }
  }
  const set = listeners.get(type) ?? new Set()
  listeners.set(type, set)
  set.add(wrapped)
  return () => set.delete(wrapped)
}

/** The Electron IPC subscriptions these keys would otherwise arrive through. */
export function createWebWindowShortcutUiApi() {
  return {
    onOpenSettings: (callback: () => void) => onWebWindowShortcut('openSettings', () => callback()),
    onToggleLeftSidebar: (callback: () => void) =>
      onWebWindowShortcut('toggleLeftSidebar', () => callback()),
    onToggleRightSidebar: (callback: () => void) =>
      onWebWindowShortcut('toggleRightSidebar', () => callback()),
    onToggleWorktreePalette: (callback: () => void) =>
      onWebWindowShortcut('toggleWorktreePalette', () => callback()),
    onToggleFloatingTerminal: (callback: () => void) =>
      onWebWindowShortcut('toggleFloatingTerminal', () => callback()),
    onOpenQuickOpen: (callback: () => void) =>
      onWebWindowShortcut('openQuickOpen', () => callback()),
    onToggleQuickCommandsMenu: (callback: () => void) =>
      onWebWindowShortcut('toggleQuickCommandsMenu', () => callback()),
    onOpenTasks: (callback: () => void) => onWebWindowShortcut('openTasks', () => callback()),
    onOpenNewWorkspace: (callback: () => void) =>
      onWebWindowShortcut('openNewWorkspace', () => callback()),
    onDeleteCurrentWorkspace: (callback: () => void) =>
      onWebWindowShortcut('deleteCurrentWorkspace', () => callback()),
    onOpenWorkspaceBoard: (callback: () => void) =>
      onWebWindowShortcut('openWorkspaceBoard', () => callback()),
    onToggleAgentDashboard: (callback: () => void) =>
      onWebWindowShortcut('toggleAgentDashboard', () => callback()),
    onSwitchRecentTab: (callback: () => void) =>
      onWebWindowShortcut('switchRecentTab', () => callback()),
    onJumpToWorktreeIndex: (callback: (index: number) => void) =>
      onWebWindowShortcut('jumpToWorktreeIndex', ({ index }) => callback(index)),
    onJumpToTabIndex: (callback: (index: number) => void) =>
      onWebWindowShortcut('jumpToTabIndex', ({ index }) => callback(index)),
    onWorktreeHistoryNavigate: (callback: (direction: 'back' | 'forward') => void) =>
      onWebWindowShortcut('worktreeHistoryNavigate', ({ direction }) => callback(direction)),
    onTerminalShortcutCaptured: (
      callback: (payload: { actionId: KeybindingActionId }) => void
    ): (() => void) => {
      captureListeners.add(callback)
      return () => captureListeners.delete(callback)
    },
    setTerminalInputFocused: (focused: boolean): void => {
      focus.terminalInput = focused
    },
    setFloatingFocus: (state: { panelFocused: boolean; terminalFocused: boolean }): void => {
      focus.floatingTerminalInput = state.terminalFocused
      focus.floatingPanel = state.panelFocused || state.terminalFocused
    },
    setMarkdownEditorFocused: (focused: boolean): void => {
      focus.markdownEditor = focused
    },
    setShortcutRecorderFocused: (focused: boolean): void => {
      focus.shortcutRecorder = focused
    }
  }
}

function consume(event: KeyboardEvent): void {
  event.preventDefault()
  event.stopImmediatePropagation()
}

/** Applies the routing main-window-shortcut-routing.ts does for Electron; returns false to leave the key alone. */
function dispatchAction(
  event: KeyboardEvent,
  action: WindowShortcutAction,
  context: KeybindingMatchOptions
): boolean {
  // Why: dictation has no web path, and web UI zoom only stores a level, so the browser keeps its own zoom.
  if (action.type === 'dictationKeyDown' || action.type === 'zoom') {
    return false
  }
  if (
    focus.floatingTerminalInput &&
    (action.type === 'toggleLeftSidebar' || action.type === 'toggleRightSidebar')
  ) {
    return false
  }
  const isIndexJump = action.type === 'jumpToWorktreeIndex' || action.type === 'jumpToTabIndex'
  if (isIndexJump && !event.repeat && focus.floatingPanel) {
    return false
  }
  const repeatIsContained =
    isIndexJump ||
    action.type === 'toggleQuickCommandsMenu' ||
    action.type === 'deleteCurrentWorkspace'
  if (repeatIsContained && event.repeat) {
    return true
  }
  if (action.type === 'forceReload') {
    window.location.reload()
    return true
  }
  // Why: before the app mounts nothing listens, so Ctrl+P and friends must stay the browser's.
  const subscribers = listeners.get(action.type)
  if (!subscribers?.size) {
    return false
  }
  if (
    context.context === 'terminal' &&
    context.terminalShortcutPolicy === 'orca-first' &&
    windowShortcutActionCapturesTerminal(action)
  ) {
    const actionId = getWindowShortcutActionId(action)
    if (actionId) {
      captureListeners.forEach((listener) => listener({ actionId }))
    }
  }
  subscribers.forEach((listener) => listener(action))
  return true
}

/** Web clients have no Electron main process, so a first capture listener stands in for before-input-event. */
export function installWebWindowShortcuts(target: Window = window): () => void {
  const platform = getBrowserPlatform()
  let keybindings: KeybindingOverrides = getWebKeybindingSnapshot().overrides
  const unsubscribeKeybindings = createWebKeybindingsApi().onChanged((snapshot) => {
    keybindings = snapshot.overrides
  })

  const onKeyDown = (event: KeyboardEvent): void => {
    // Why: this runs on every keystroke and reading the policy parses JSON, so plain typing leaves here.
    if (!event.ctrlKey && !event.metaKey && !event.altKey && !/^F\d+$/.test(event.key)) {
      return
    }
    if (focus.shortcutRecorder || event.isComposing || event.key === 'Process') {
      return
    }
    const context: KeybindingMatchOptions = {
      context: focus.terminalInput || focus.floatingTerminalInput ? 'terminal' : 'app',
      terminalShortcutPolicy: normalizeTerminalShortcutPolicy(
        readJson<Partial<GlobalSettings>>(SETTINGS_STORAGE_KEY, {}).terminalShortcutPolicy
      )
    }
    const input = {
      type: 'keyDown',
      key: event.key,
      code: event.code,
      altKey: event.altKey,
      metaKey: event.metaKey,
      ctrlKey: event.ctrlKey,
      shiftKey: event.shiftKey,
      altGraph: event.getModifierState('AltGraph')
    }
    if (matchesRecentTabSwitcherChord(input, platform, keybindings, context)) {
      return
    }
    // TipTap owns bare Cmd/Ctrl+B only; preserve modifier variants (docs/markdown-cmd-b-bold-design.md).
    const primaryModifier = platform === 'darwin' ? event.metaKey : event.ctrlKey
    if (
      focus.markdownEditor &&
      event.code === 'KeyB' &&
      !event.altKey &&
      !event.shiftKey &&
      primaryModifier
    ) {
      return
    }
    const action = resolveWindowShortcutAction(input, platform, keybindings, context)
    if (action && dispatchAction(event, action, context)) {
      consume(event)
    }
  }

  target.addEventListener('keydown', onKeyDown, { capture: true })
  return () => {
    target.removeEventListener('keydown', onKeyDown, { capture: true })
    unsubscribeKeybindings()
  }
}
