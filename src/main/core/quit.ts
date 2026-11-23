// What a `before-quit` does (docs/ARCHITECTURE.md §5): the flags live in src/main/index.ts, the
// decision here, where it can be tested.

export interface QuitState {
  /** the shutdown is through */
  ready: boolean
  /** the user chose "Quit" in the quit question */
  confirmed: boolean
  /** logout, restart or shutdown of the Mac */
  system: boolean
  /** the quit question is open */
  asking: boolean
  e2e: boolean
  /** an analysis or an export runs (JobManager.hasUnfinishedWork) */
  unfinishedWork: boolean
}

/**
 * 'quit': let the app go · 'ask': hold the quit and open the question · 'wait': hold it, the
 * question is already open · 'shutdown': hold it, stop the jobs and save, then quit again
 */
export function quitStep(state: QuitState): 'quit' | 'ask' | 'wait' | 'shutdown' {
  if (state.ready) return 'quit'
  if (state.confirmed || state.system || state.e2e || !state.unfinishedWork) return 'shutdown'
  return state.asking ? 'wait' : 'ask'
}
