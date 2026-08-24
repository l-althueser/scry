/** "Set Transparent Color" — same one-shot eyedropper behavior PowerPoint offers for removing a flat background (e.g. white) from a pasted image. Applied once, baked directly into the returned data URI: this app models an image layer with a single `src`, so there's no separate "original" kept around to re-pick from later — picking again just needs re-importing the source image. */

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('Failed to load image'))
    img.src = src
  })
}

function drawToCanvas(img: HTMLImageElement): CanvasRenderingContext2D {
  const canvas = document.createElement('canvas')
  canvas.width = img.naturalWidth
  canvas.height = img.naturalHeight
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas 2D context unavailable')
  ctx.drawImage(img, 0, 0)
  return ctx
}

function toHex(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('')}`
}

/** Samples the pixel color at a fractional (0..1, relative to the image's own footprint) position — backs the "pick transparent color" eyedropper tool, see SvgCanvas's pick-transparent-color tool. */
export async function samplePixelColor(src: string, relX: number, relY: number): Promise<string> {
  const img = await loadImage(src)
  const ctx = drawToCanvas(img)
  const px = Math.min(img.naturalWidth - 1, Math.max(0, Math.floor(relX * img.naturalWidth)))
  const py = Math.min(img.naturalHeight - 1, Math.max(0, Math.floor(relY * img.naturalHeight)))
  const [r, g, b] = ctx.getImageData(px, py, 1, 1).data
  return toHex(r, g, b)
}

/** Re-encodes the image with every pixel exactly matching hexColor made fully transparent. */
export async function applyTransparentColor(src: string, hexColor: string): Promise<string> {
  const img = await loadImage(src)
  const ctx = drawToCanvas(img)
  const { width, height } = ctx.canvas
  const imageData = ctx.getImageData(0, 0, width, height)
  const data = imageData.data
  const hex = hexColor.replace('#', '')
  const tr = parseInt(hex.slice(0, 2), 16)
  const tg = parseInt(hex.slice(2, 4), 16)
  const tb = parseInt(hex.slice(4, 6), 16)
  for (let i = 0; i < data.length; i += 4) {
    if (data[i] === tr && data[i + 1] === tg && data[i + 2] === tb) {
      data[i + 3] = 0
    }
  }
  ctx.putImageData(imageData, 0, 0)
  return ctx.canvas.toDataURL('image/png')
}
