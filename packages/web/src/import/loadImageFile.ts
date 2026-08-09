/** Reads a File (raster or SVG) as a data URI and resolves its natural pixel size, for a sensible default placement. */
export function loadImageFile(file: File): Promise<{ src: string; width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read file'))
    reader.onload = () => {
      const src = reader.result as string
      const img = new Image()
      img.onerror = () => reject(new Error('Failed to load image'))
      img.onload = () => resolve({ src, width: img.naturalWidth || 400, height: img.naturalHeight || 300 })
      img.src = src
    }
    reader.readAsDataURL(file)
  })
}
