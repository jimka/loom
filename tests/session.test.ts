import { describe, it, expect } from 'vitest'
import { emptySession, parseSession, serializeSession, expansionOrder } from '../src/data/session'
import type { SessionState } from '../src/data/session'

describe('emptySession', () => {
  it('returns a session with every field at its empty default', () => {
    expect(emptySession()).toEqual({
      version: 1,
      projectRoot: null,
      expandedDirs: [],
      openFiles: [],
      activeFile: null,
      paneSizes: [],
      collapsedPanes: [],
    })
  })
})

describe('parseSession', () => {
  it('returns an empty session for an empty string', () => {
    expect(parseSession('')).toEqual(emptySession())
  })

  it('returns an empty session for text that is not JSON', () => {
    expect(parseSession('not json')).toEqual(emptySession())
  })

  it('returns an empty session when the top level is an array', () => {
    expect(parseSession('[]')).toEqual(emptySession())
  })

  it('returns an empty session when the top level is null', () => {
    expect(parseSession('null')).toEqual(emptySession())
  })

  it('returns an empty session when version is not 1', () => {
    expect(parseSession('{"version":2,"openFiles":["/p/a.ts"]}')).toEqual(emptySession())
  })

  it('returns every field verbatim for a complete, valid document', () => {
    const state: SessionState = {
      version: 1,
      projectRoot: '/p',
      expandedDirs: ['/p/src', '/p/src/data'],
      openFiles: ['/p/src/main.ts', '/p/README.md'],
      activeFile: '/p/README.md',
      paneSizes: [{ unit: 'px', value: 300 }, { unit: 'ratio', value: 1 }],
      collapsedPanes: [],
    }

    expect(parseSession(JSON.stringify(state))).toEqual(state)
  })

  it('takes just openFiles and empty defaults for the rest, given a partial document', () => {
    expect(parseSession('{"version":1,"openFiles":["/p/a.ts"]}')).toEqual({
      ...emptySession(),
      openFiles: ['/p/a.ts'],
    })
  })

  it('drops openFiles whole when one entry has the wrong type', () => {
    expect(parseSession('{"version":1,"openFiles":["/p/a.ts",7]}')).toEqual(emptySession())
  })

  it('drops paneSizes whole when one entry has an invalid unit, keeps a valid one', () => {
    expect(parseSession('{"version":1,"paneSizes":[{"unit":"em","value":3}]}')).toEqual(emptySession())

    expect(parseSession('{"version":1,"paneSizes":[{"unit":"px","value":300}]}')).toEqual({
      ...emptySession(),
      paneSizes: [{ unit: 'px', value: 300 }],
    })
  })

  it('takes the empty default when projectRoot has the wrong type', () => {
    expect(parseSession('{"version":1,"projectRoot":5}')).toEqual(emptySession())
  })

  it('ignores unknown fields', () => {
    expect(parseSession('{"version":1,"recentProjects":[]}')).toEqual(emptySession())
  })
})

describe('serializeSession', () => {
  it('round-trips a fully populated state through parseSession', () => {
    const state: SessionState = {
      version: 1,
      projectRoot: '/p',
      expandedDirs: ['/p/src', '/p/src/data'],
      openFiles: ['/p/src/main.ts', '/p/README.md'],
      activeFile: '/p/README.md',
      paneSizes: [{ unit: 'px', value: 300 }, { unit: 'ratio', value: 1 }],
      collapsedPanes: [1],
    }

    expect(parseSession(serializeSession(state))).toEqual(state)
  })
})

describe('expansionOrder', () => {
  it('orders a directory ahead of anything nested inside it', () => {
    expect(expansionOrder(['/p/src/data', '/p', '/p/src'])).toEqual(['/p', '/p/src', '/p/src/data'])
  })

  it('returns an empty array for an empty input', () => {
    expect(expansionOrder([])).toEqual([])
  })

  it('leaves its input array unmutated', () => {
    const input = ['/p/src/data', '/p', '/p/src']
    const original = [...input]

    expansionOrder(input)

    expect(input).toEqual(original)
  })
})
