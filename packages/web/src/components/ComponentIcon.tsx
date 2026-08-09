import { useEffect, useRef } from 'react'
import { createComponentThumbnail } from '../library'

/** Small live preview of a component type, built from the same render() DOM as the real canvas. */
export function ComponentIcon({ typeId }: { typeId: string }) {
  const containerRef = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const svg = createComponentThumbnail(typeId)
    container.appendChild(svg)
    return () => {
      container.removeChild(svg)
    }
  }, [typeId])

  return <span ref={containerRef} className="component-icon" aria-hidden="true" />
}
