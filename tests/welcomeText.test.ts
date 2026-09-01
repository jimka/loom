import { describe, it, expect } from 'vitest'
import { welcomeCopy } from '../src/shell/welcomeText'
import { APP_NAME } from '../src/appIdentity'

describe('welcomeCopy', () => {
  it('shows the app-wide heading and hint when no project is open', () => {
    expect(welcomeCopy(null)).toEqual({
      heading: 'Welcome to Loom',
      hint: 'Open a project folder to start editing.',
    })
  })

  it('shows the project name and file hint when a project is open', () => {
    expect(welcomeCopy('/home/jika/typescript/loom')).toEqual({
      heading: 'loom',
      hint: 'Select a file in the explorer to start editing.',
    })
  })

  it('builds the no-project heading from APP_NAME rather than a literal', () => {
    expect(welcomeCopy(null).heading).toContain(APP_NAME)
  })
})
