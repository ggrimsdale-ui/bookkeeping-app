import type { ReportParams } from '../../shared/types'

export type View =
  | { name: 'home' }
  | { name: 'accounts' }
  | { name: 'entries' }
  | { name: 'entry'; id?: number }
  | { name: 'reports' }
  | { name: 'report'; params: ReportParams }
  | { name: 'settings' }

export interface Nav {
  view: View
  /** Opens a view on top of the current one so Back returns here. */
  push(view: View): void
  /** Replaces the whole stack (sidebar navigation). */
  go(view: View): void
  back(): void
  canGoBack: boolean
  /** Bumped after any change so open views reload their data. */
  version: number
  changed(): void
}
