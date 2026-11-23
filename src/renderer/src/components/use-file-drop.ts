import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { isFileDrag } from '../lib/dom'

/**
 * Window-wide drop target for files from Finder. Returns true while files hover over the window.
 * In-app drags (e.g. reordering clips) are ignored.
 */
export function useFileDrop(onPaths: (paths: string[]) => void, enabled = true): boolean {
  const [active, setActive] = useState(false)
  const depth = useRef(0)
  const onPathsRef = useRef(onPaths)
  useEffect(() => {
    onPathsRef.current = onPaths
  })

  useEffect(() => {
    if (!enabled) return
    const enter = (event: DragEvent): void => {
      if (!isFileDrag(event)) return
      event.preventDefault()
      depth.current++
      setActive(true)
    }
    const over = (event: DragEvent): void => {
      if (!isFileDrag(event)) return
      event.preventDefault()
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
    }
    const leave = (event: DragEvent): void => {
      if (!isFileDrag(event)) return
      depth.current = Math.max(0, depth.current - 1)
      if (depth.current === 0) setActive(false)
    }
    const drop = (event: DragEvent): void => {
      if (!isFileDrag(event)) return
      event.preventDefault()
      depth.current = 0
      setActive(false)
      const files = Array.from(event.dataTransfer?.files ?? [])
      const paths = files.map((file) => api().getPathForFile(file)).filter(Boolean)
      if (paths.length > 0) onPathsRef.current(paths)
    }
    window.addEventListener('dragenter', enter)
    window.addEventListener('dragover', over)
    window.addEventListener('dragleave', leave)
    window.addEventListener('drop', drop)
    return () => {
      window.removeEventListener('dragenter', enter)
      window.removeEventListener('dragover', over)
      window.removeEventListener('dragleave', leave)
      window.removeEventListener('drop', drop)
      depth.current = 0
      setActive(false)
    }
  }, [enabled])

  return active
}

/** Without a drop target, Electron would navigate to a dropped file – never let that happen. */
export function usePreventFileNavigation(): void {
  useEffect(() => {
    const prevent = (event: DragEvent): void => {
      if (isFileDrag(event)) event.preventDefault()
    }
    window.addEventListener('dragover', prevent)
    window.addEventListener('drop', prevent)
    return () => {
      window.removeEventListener('dragover', prevent)
      window.removeEventListener('drop', prevent)
    }
  }, [])
}
