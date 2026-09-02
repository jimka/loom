import { describe, it, expect } from 'vitest'
import { emptyWorkspaceState, parseWorkspaceState, serializeWorkspaceState, workspaceStateFromSession, applyWorkspaceOverlay } from '../src/data/workspaceState'
import type { WorkspaceState } from '../src/data/workspaceState'
import { emptySession } from '../src/data/session'
import type { SessionState } from '../src/data/session'

describe('emptyWorkspaceState', () => {
  it('returns a workspace state with every field at its empty default', () => {
    expect(emptyWorkspaceState()).toEqual({
      version: 1,
      expandedDirs: [],
      openFiles: [],
      activeFile: null,
      paneSizes: [],
      collapsedPanes: [],
    })
  })
})

describe('parseWorkspaceState', () => {
  it('returns null for an empty string', () => {
    expect(parseWorkspaceState('')).toBeNull()
  })

  it('returns null for text that is not JSON', () => {
    expect(parseWorkspaceState('not json')).toBeNull()
  })

  it('returns null when the top level is an array', () => {
    expect(parseWorkspaceState('[]')).toBeNull()
  })

  it('returns null when the top level is null', () => {
    expect(parseWorkspaceState('null')).toBeNull()
  })

  it('returns null when version is not 1', () => {
    expect(parseWorkspaceState('{"version":2,"openFiles":["/p/a.ts"]}')).toBeNull()
  })

  it('returns emptyWorkspaceState for a minimal valid document', () => {
    expect(parseWorkspaceState('{"version":1}')).toEqual(emptyWorkspaceState())
  })

  it('takes just openFiles and empty defaults for the rest, given a partial document', () => {
    expect(parseWorkspaceState('{"version":1,"openFiles":["/p/a.ts"]}')).toEqual({
      ...emptyWorkspaceState(),
      openFiles: ['/p/a.ts'],
    })
  })

  it('drops openFiles whole when one entry has the wrong type', () => {
    expect(parseWorkspaceState('{"version":1,"openFiles":["/p/a.ts",7]}')).toEqual({
      ...emptyWorkspaceState(),
      openFiles: [],
    })
  })

  it('takes the empty default when activeFile has the wrong type', () => {
    expect(parseWorkspaceState('{"version":1,"activeFile":5}')).toEqual({
      ...emptyWorkspaceState(),
      activeFile: null,
    })
  })

  it('drops paneSizes whole when one entry has an invalid unit, keeps a valid one', () => {
    expect(parseWorkspaceState('{"version":1,"paneSizes":[{"unit":"em","value":3}]}')).toEqual({
      ...emptyWorkspaceState(),
      paneSizes: [],
    })

    expect(parseWorkspaceState('{"version":1,"paneSizes":[{"unit":"px","value":300}]}')).toEqual({
      ...emptyWorkspaceState(),
      paneSizes: [{ unit: 'px', value: 300 }],
    })
  })

  it('drops collapsedPanes whole when one entry has the wrong type', () => {
    expect(parseWorkspaceState('{"version":1,"collapsedPanes":[0,"1"]}')).toEqual({
      ...emptyWorkspaceState(),
      collapsedPanes: [],
    })
  })

  it('ignores unknown fields', () => {
    expect(parseWorkspaceState('{"version":1,"futureField":true}')).toEqual(emptyWorkspaceState())
  })
})

describe('serializeWorkspaceState', () => {
  it('round-trips a fully populated state through parseWorkspaceState', () => {
    const state: WorkspaceState = {
      version: 1,
      expandedDirs: ['/p/src', '/p/src/data'],
      openFiles: ['/p/src/main.ts', '/p/README.md'],
      activeFile: '/p/README.md',
      paneSizes: [{ unit: 'px', value: 300 }, { unit: 'ratio', value: 1 }],
      collapsedPanes: [1],
    }

    expect(parseWorkspaceState(serializeWorkspaceState(state))).toEqual(state)
  })
})

describe('workspaceStateFromSession', () => {
  it('returns emptyWorkspaceState for a session with a null projectRoot', () => {
    const session: SessionState = { ...emptySession(), openFiles: ['/p/a.ts'] }

    expect(workspaceStateFromSession(session)).toEqual(emptyWorkspaceState())
  })

  it('drops openFiles and activeFile outside projectRoot', () => {
    const session: SessionState = {
      ...emptySession(),
      projectRoot: '/p',
      openFiles: ['/p/a.ts', '/q/b.ts'],
      activeFile: '/q/b.ts',
    }

    expect(workspaceStateFromSession(session)).toEqual({
      ...emptyWorkspaceState(),
      openFiles: ['/p/a.ts'],
      activeFile: null,
    })
  })

  it('keeps activeFile when it is inside projectRoot', () => {
    const session: SessionState = {
      ...emptySession(),
      projectRoot: '/p',
      openFiles: ['/p/a.ts'],
      activeFile: '/p/a.ts',
    }

    expect(workspaceStateFromSession(session).activeFile).toBe('/p/a.ts')
  })

  it('copies paneSizes and collapsedPanes verbatim regardless of projectRoot', () => {
    const session: SessionState = {
      ...emptySession(),
      projectRoot: '/p',
      paneSizes: [{ unit: 'px', value: 420 }],
      collapsedPanes: [0],
    }

    expect(workspaceStateFromSession(session)).toEqual({
      ...emptyWorkspaceState(),
      paneSizes: [{ unit: 'px', value: 420 }],
      collapsedPanes: [0],
    })
  })
})

describe('applyWorkspaceOverlay', () => {
  it('returns session unchanged when workspace is null', () => {
    const session: SessionState = { ...emptySession(), projectRoot: '/p', openFiles: ['/p/a.ts'] }

    expect(applyWorkspaceOverlay(session, null)).toBe(session)
  })

  it('returns session unchanged when session.projectRoot is null, even with a non-null workspace', () => {
    const session: SessionState = { ...emptySession(), projectRoot: null }
    const workspace: WorkspaceState = { ...emptyWorkspaceState(), openFiles: ['/p/a.ts'] }

    expect(applyWorkspaceOverlay(session, workspace)).toBe(session)
  })

  it('replaces the five overlay fields with workspace\'s, leaving version and projectRoot unchanged', () => {
    const session: SessionState = {
      version: 1,
      projectRoot: '/p',
      expandedDirs: ['/p/old'],
      openFiles: ['/p/old.ts'],
      activeFile: '/p/old.ts',
      paneSizes: [{ unit: 'px', value: 100 }],
      collapsedPanes: [],
      recentProjects: [],
      recentFiles: [],
    }
    const workspace: WorkspaceState = {
      version: 1,
      expandedDirs: ['/p/src'],
      openFiles: ['/p/a.ts'],
      activeFile: '/p/a.ts',
      paneSizes: [{ unit: 'px', value: 300 }, { unit: 'ratio', value: 1 }],
      collapsedPanes: [0],
    }

    expect(applyWorkspaceOverlay(session, workspace)).toEqual({
      version: 1,
      projectRoot: '/p',
      expandedDirs: ['/p/src'],
      openFiles: ['/p/a.ts'],
      activeFile: '/p/a.ts',
      paneSizes: [{ unit: 'px', value: 300 }, { unit: 'ratio', value: 1 }],
      collapsedPanes: [0],
      recentProjects: [],
      recentFiles: [],
    })
  })

  it('drops a workspace openFiles path outside session.projectRoot', () => {
    const session: SessionState = { ...emptySession(), projectRoot: '/p' }
    const workspace: WorkspaceState = { ...emptyWorkspaceState(), openFiles: ['/p/a.ts', '/q/b.ts'] }

    expect(applyWorkspaceOverlay(session, workspace).openFiles).toEqual(['/p/a.ts'])
  })

  it('copies paneSizes and collapsedPanes verbatim, with no root filtering', () => {
    const session: SessionState = { ...emptySession(), projectRoot: '/p' }
    const workspace: WorkspaceState = {
      ...emptyWorkspaceState(),
      paneSizes: [{ unit: 'px', value: 555 }],
      collapsedPanes: [0, 1],
    }

    const result = applyWorkspaceOverlay(session, workspace)

    expect(result.paneSizes).toEqual([{ unit: 'px', value: 555 }])
    expect(result.collapsedPanes).toEqual([0, 1])
  })
})
