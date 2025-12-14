import * as exifr from 'exifr'
import libheif from 'libheif-js/wasm-bundle'

type ScrubRequest = {
  id: string
  fileName: string
  mimeType: string
  bytes: ArrayBuffer
  outputType: 'image/jpeg' | 'image/png' | 'image/webp'
  quality: number
}

type Verification = {
  hasExif: boolean
  hasXmp: boolean
  hasIptc: boolean
  exifKeys: string[]
  gps?: { latitude?: number; longitude?: number }
  dateTimeOriginal?: string
  make?: string
  model?: string
  software?: string
}

type ScrubResponse =
  | {
      id: string
      ok: true
      cleanedBytes: ArrayBuffer
      cleanedMimeType: string
      before: Verification
      after: Verification
    }
  | {
      id: string
      ok: false
      error: string
    }

function includesAscii(bytes: Uint8Array, needle: string): boolean {
  const n = needle.length
  if (n === 0) return true

  const first = needle.charCodeAt(0) & 0xff
  for (let i = 0; i <= bytes.length - n; i++) {
    if (bytes[i] !== first) continue
    let ok = true
    for (let j = 1; j < n; j++) {
      if (bytes[i + j] !== (needle.charCodeAt(j) & 0xff)) {
        ok = false
        break
      }
    }
    if (ok) return true
  }
  return false
}

function verify(bytes: ArrayBuffer): Verification {
  const u8 = new Uint8Array(bytes)
  const hasXmp =
    includesAscii(u8, '<x:xmpmeta') ||
    includesAscii(u8, 'http://ns.adobe.com/xap/1.0/') ||
    includesAscii(u8, 'http://purl.org/dc/elements/1.1/')
  const hasIptc =
    includesAscii(u8, 'Photoshop 3.0') ||
    includesAscii(u8, 'IPTC') ||
    includesAscii(u8, '8BIM')
  const exifKeys: string[] = []
  return {
    hasExif: includesAscii(u8, 'Exif'),
    hasXmp,
    hasIptc,
    exifKeys,
  }
}

async function verifyDeep(bytes: ArrayBuffer): Promise<Verification> {
  const base = verify(bytes)

  try {
    const parsed = await exifr.parse(bytes, {
      translateKeys: false,
      mergeOutput: true,
      tiff: true,
      exif: true,
      gps: true,
      iptc: false,
      xmp: false,
    })

    if (parsed && typeof parsed === 'object') {
      const keys = Object.keys(parsed).sort()
      base.exifKeys = keys
      base.hasExif = base.hasExif || keys.length > 0

      const latitude = (parsed.GPSLatitude ?? parsed.latitude) as number | undefined
      const longitude = (parsed.GPSLongitude ?? parsed.longitude) as number | undefined
      if (typeof latitude === 'number' || typeof longitude === 'number') {
        base.gps = { latitude, longitude }
      }

      base.dateTimeOriginal =
        (parsed.DateTimeOriginal ?? parsed.DateTime ?? parsed['Date/Time Original']) as
          | string
          | undefined
      base.make = (parsed.Make ?? parsed.make) as string | undefined
      base.model = (parsed.Model ?? parsed.model) as string | undefined
      base.software = (parsed.Software ?? parsed.software) as string | undefined
    }
  } catch {
    // Ignore parse errors; base marker detection is still useful.
  }

  return base
}

function isHeicLike(fileName: string, mimeType: string): boolean {
  const n = fileName.toLowerCase()
  const m = mimeType.toLowerCase()
  return (
    n.endsWith('.heic') ||
    n.endsWith('.heif') ||
    n.endsWith('.avif') ||
    m.includes('heic') ||
    m.includes('heif') ||
    m.includes('avif')
  )
}

async function decodeHeicToImageData(bytes: ArrayBuffer): Promise<ImageData> {
  const anyLibHeif = libheif as unknown as { HeifDecoder: new () => { decode: (b: Uint8Array) => any[] } }
  const decoder = new anyLibHeif.HeifDecoder()
  const data = decoder.decode(new Uint8Array(bytes))
  if (!data || !data.length) {
    throw new Error('HEIC decode failed: no images found')
  }

  const image = data[0]
  const width = image.get_width()
  const height = image.get_height()

  const canvas = new OffscreenCanvas(width, height)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Failed to create canvas context')

  const imgData = ctx.createImageData(width, height)
  await new Promise<void>((resolve, reject) => {
    image.display(imgData, (displayData: ImageData | undefined) => {
      if (!displayData) {
        reject(new Error('HEIC processing error'))
        return
      }
      resolve()
    })
  })

  return imgData
}

async function scrub(req: ScrubRequest): Promise<ScrubResponse> {
  try {
    const before = await verifyDeep(req.bytes)

    const canvas: OffscreenCanvas = await (async () => {
      if (isHeicLike(req.fileName, req.mimeType)) {
        const imgData = await decodeHeicToImageData(req.bytes)
        const c = new OffscreenCanvas(imgData.width, imgData.height)
        const ctx = c.getContext('2d')
        if (!ctx) throw new Error('Failed to create canvas context')
        ctx.putImageData(imgData, 0, 0)
        return c
      }

      const blob = new Blob([req.bytes], { type: req.mimeType })
      const bitmap = await createImageBitmap(blob)
      const c = new OffscreenCanvas(bitmap.width, bitmap.height)
      const ctx = c.getContext('2d')
      if (!ctx) throw new Error('Failed to create canvas context')
      ctx.drawImage(bitmap, 0, 0)
      return c
    })()

    const out = await canvas.convertToBlob({
      type: req.outputType,
      quality: Math.min(1, Math.max(0, req.quality)),
    })

    const cleanedBytes = await out.arrayBuffer()
    const after = await verifyDeep(cleanedBytes)

    return {
      id: req.id,
      ok: true,
      cleanedBytes,
      cleanedMimeType: out.type || req.outputType,
      before,
      after,
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { id: req.id, ok: false, error: msg }
  }
}

self.onmessage = async (ev: MessageEvent<ScrubRequest>) => {
  const res = await scrub(ev.data)
  if (res.ok) {
    ;(self as unknown as Worker).postMessage(res, [res.cleanedBytes])
  } else {
    ;(self as unknown as Worker).postMessage(res)
  }
}
