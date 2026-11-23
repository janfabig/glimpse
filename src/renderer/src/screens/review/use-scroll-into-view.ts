import { useEffect, type DependencyList, type RefObject } from 'react'

/** keeps the element matching `selector` inside `container` visible whenever `deps` change */
export function useScrollIntoView(
  container: RefObject<HTMLElement | null>,
  selector: string,
  deps: DependencyList
): void {
  useEffect(() => {
    container.current?.querySelector(selector)?.scrollIntoView({ block: 'nearest' })
    // the caller decides when to scroll
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
}
