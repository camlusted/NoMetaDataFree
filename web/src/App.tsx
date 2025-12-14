import { useEffect, useMemo, useRef, useState } from 'react'
import JSZip from 'jszip'
import './App.css'

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

type BatchItem = {
  id: string
  file: File
  originalUrl: string
  status: 'pending' | 'processing' | 'done' | 'error'
  error?: string
  before?: Verification
  after?: Verification
  cleanedBlob?: Blob
  cleanedUrl?: string
}

function App() {
  const [items, setItems] = useState<BatchItem[]>([])
  const [isDragging, setIsDragging] = useState(false)

  const [outputType, setOutputType] = useState<'image/jpeg' | 'image/png' | 'image/webp'>(
    'image/jpeg',
  )
  const [quality, setQuality] = useState<number>(0.92)

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const workerRef = useRef<Worker | null>(null)

  useEffect(() => {
    workerRef.current = new Worker(new URL('./workers/scrubWorker.ts', import.meta.url), {
      type: 'module',
    })

    return () => {
      workerRef.current?.terminate()
      workerRef.current = null
    }
  }, [])

  useEffect(() => {
    return () => {
      for (const it of items) {
        URL.revokeObjectURL(it.originalUrl)
        if (it.cleanedUrl) URL.revokeObjectURL(it.cleanedUrl)
      }
    }
  }, [items])

  const canScrub = useMemo(() => items.length > 0 && !busy, [items.length, busy])
  const cleanedCount = useMemo(
    () => items.filter((i) => i.status === 'done' && i.cleanedBlob).length,
    [items],
  )
  const processedCount = useMemo(
    () => items.filter((i) => i.status === 'done' || i.status === 'error').length,
    [items],
  )

  function resetOutputs() {
    setError(null)
    setItems((prev) =>
      prev.map((it) => {
        if (it.cleanedUrl) URL.revokeObjectURL(it.cleanedUrl)
        return {
          ...it,
          status: 'pending',
          error: undefined,
          before: undefined,
          after: undefined,
          cleanedBlob: undefined,
          cleanedUrl: undefined,
        }
      }),
    )
  }

  function onPickFiles(files: FileList | File[]) {
    setError(null)

    setItems((prev) => {
      for (const it of prev) {
        URL.revokeObjectURL(it.originalUrl)
        if (it.cleanedUrl) URL.revokeObjectURL(it.cleanedUrl)
      }

      const list = Array.from(files)
      return list.map((file) => ({
        id: crypto.randomUUID(),
        file,
        originalUrl: URL.createObjectURL(file),
        status: 'pending',
      }))
    })
  }

  async function onScrub() {
    if (items.length === 0) return
    if (!workerRef.current) {
      setError('Worker not initialized')
      return
    }

    resetOutputs()
    setBusy(true)

    const worker = workerRef.current

    for (const it of items) {
      setItems((prev) => prev.map((p) => (p.id === it.id ? { ...p, status: 'processing' } : p)))

      const bytes = await it.file.arrayBuffer()
      const payload = {
        id: it.id,
        fileName: it.file.name,
        mimeType: it.file.type || 'application/octet-stream',
        bytes,
        outputType,
        quality,
      }

      const res: ScrubResponse = await new Promise((resolve) => {
        const onMessage = (ev: MessageEvent<ScrubResponse>) => {
          if (ev.data.id !== it.id) return
          worker.removeEventListener('message', onMessage)
          resolve(ev.data)
        }
        worker.addEventListener('message', onMessage)
        worker.postMessage(payload, [bytes])
      })

      if (!res.ok) {
        setItems((prev) =>
          prev.map((p) =>
            p.id === it.id ? { ...p, status: 'error', error: res.error } : p,
          ),
        )
        continue
      }

      const blob = new Blob([res.cleanedBytes], { type: res.cleanedMimeType })
      const url = URL.createObjectURL(blob)
      setItems((prev) =>
        prev.map((p) =>
          p.id === it.id
            ? {
                ...p,
                status: 'done',
                before: res.before,
                after: res.after,
                cleanedBlob: blob,
                cleanedUrl: url,
              }
            : p,
        ),
      )
    }

    setBusy(false)
  }

  function downloadOne(it: BatchItem) {
    if (!it.cleanedBlob) return
    const ext =
      it.cleanedBlob.type === 'image/png'
        ? 'png'
        : it.cleanedBlob.type === 'image/webp'
          ? 'webp'
          : 'jpg'

    const base = it.file.name.replace(/\.[^.]+$/, '') || 'image'
    const a = document.createElement('a')
    a.href = URL.createObjectURL(it.cleanedBlob)
    a.download = `${base}.clean.${ext}`
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(a.href), 1000)
  }

  async function downloadZip() {
    const done = items.filter((i) => i.status === 'done' && i.cleanedBlob)
    if (done.length === 0) return

    const zip = new JSZip()
    for (const it of done) {
      const blob = it.cleanedBlob!
      const ext =
        blob.type === 'image/png' ? 'png' : blob.type === 'image/webp' ? 'webp' : 'jpg'
      const base = it.file.name.replace(/\.[^.]+$/, '') || 'image'
      zip.file(`${base}.clean.${ext}`, await blob.arrayBuffer())
    }

    const out = await zip.generateAsync({ type: 'blob' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(out)
    a.download = `NoMetaDataFree.cleaned.zip`
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(a.href), 1000)
  }

  const previewOriginal = items[0]?.originalUrl ?? null
  const previewCleaned = items.find((i) => i.cleanedUrl)?.cleanedUrl ?? null

  const progressLabel = useMemo(() => {
    if (!busy) return null
    return `${processedCount}/${items.length}`
  }, [busy, processedCount, items.length])

  function badgeFor(it: BatchItem): { text: string; className: string } {
    if (it.status === 'processing') return { text: 'Processing', className: 'badge' }
    if (it.status === 'pending') return { text: 'Queued', className: 'badge' }
    if (it.status === 'error') return { text: 'Error', className: 'badge badgeErr' }
    if (!it.after) return { text: 'Done', className: 'badge' }

    const ok = !it.after.hasExif && !it.after.hasXmp && !it.after.hasIptc
    return ok ? { text: 'Clean', className: 'badge badgeOk' } : { text: 'Not clean', className: 'badge badgeWarn' }
  }

  function buildFindings(v?: Verification): {
    key: string
    title: string
    value?: string
    why: string
    cls: 'chipOk' | 'chipWarn'
  }[] {
    if (!v) return []

    const findings: {
      key: string
      title: string
      value?: string
      why: string
      cls: 'chipOk' | 'chipWarn'
    }[] = []

    const hasGps = !!v.gps && (typeof v.gps.latitude === 'number' || typeof v.gps.longitude === 'number')
    findings.push({
      key: 'gps',
      title: 'Location (GPS)',
      value: hasGps ? `${v.gps?.latitude ?? '—'}, ${v.gps?.longitude ?? '—'}` : undefined,
      why: 'Can reveal where the photo was taken, and link posts to real-world locations.',
      cls: hasGps ? 'chipWarn' : 'chipOk',
    })

    const hasTime = !!v.dateTimeOriginal
    findings.push({
      key: 'time',
      title: 'Timestamp',
      value: v.dateTimeOriginal,
      why: 'Can reveal when a photo was taken and help build timelines when combined with other clues.',
      cls: hasTime ? 'chipWarn' : 'chipOk',
    })

    const hasDevice = !!v.make || !!v.model
    findings.push({
      key: 'device',
      title: 'Device',
      value: [v.make, v.model].filter(Boolean).join(' '),
      why: 'Can reveal the camera/phone model and sometimes distinguish you from others (profiling/triangulation).',
      cls: hasDevice ? 'chipWarn' : 'chipOk',
    })

    const hasSoftware = !!v.software
    findings.push({
      key: 'software',
      title: 'Editing software',
      value: v.software,
      why: 'Can reveal what apps touched the file and help correlate files made by the same workflow.',
      cls: hasSoftware ? 'chipWarn' : 'chipOk',
    })

    const exifCount = v.exifKeys?.length ?? 0
    findings.push({
      key: 'exif',
      title: 'EXIF tags',
      value: exifCount ? `${exifCount} tag${exifCount === 1 ? '' : 's'}` : undefined,
      why: 'EXIF is the main bucket for camera metadata (GPS, time, settings, orientation).',
      cls: exifCount ? 'chipWarn' : 'chipOk',
    })

    findings.push({
      key: 'xmp',
      title: 'XMP',
      value: v.hasXmp ? 'Detected' : undefined,
      why: 'XMP often stores editing/export history and descriptive fields; it can leak workflow/identity hints.',
      cls: v.hasXmp ? 'chipWarn' : 'chipOk',
    })

    findings.push({
      key: 'iptc',
      title: 'IPTC',
      value: v.hasIptc ? 'Detected' : undefined,
      why: 'IPTC can include author/copyright/captions common in professional publishing.',
      cls: v.hasIptc ? 'chipWarn' : 'chipOk',
    })

    return findings
  }

  function keyHighlights(keys?: string[]): string[] {
    if (!keys || keys.length === 0) return []
    const interesting = [
      'GPSLatitude',
      'GPSLongitude',
      'GPSAltitude',
      'DateTimeOriginal',
      'DateTime',
      'Make',
      'Model',
      'Software',
      'LensModel',
      'SerialNumber',
      'BodySerialNumber',
    ]
    const set = new Set(keys)
    const picked = interesting.filter((k) => set.has(k))
    return picked.length ? picked : keys.slice(0, 12)
  }

  const sponsors = useMemo(
    () =>
      [
        {
          title: 'Sponsor slot',
          body: 'Add your sponsor copy here (static card, no popups).',
          href: '#',
        },
        {
          title: 'Sponsor slot',
          body: 'Good fit: privacy tools, photo apps, security education.',
          href: '#',
        },
      ] as const,
    [],
  )

  return (
    <div className="page">
      <div className="layout">
        <main className="main">
          <div className="app">
            <div className="topbar">
              <div className="brand">
                <h1 className="title">NoMetaDataFree</h1>
                <p className="subtitle">Local-only image metadata scrubbing (EXIF/XMP/IPTC). Nothing is uploaded.</p>
              </div>
              <div className="pill">
                <span>{items.length ? `${items.length} file${items.length === 1 ? '' : 's'}` : 'No files yet'}</span>
                {busy ? <span className="muted">{progressLabel}</span> : null}
              </div>
            </div>

            <div className="grid">
              <div className="panel">
                <div className="panelHeader">
                  <h2 className="panelTitle">Import & scrub</h2>
                  <span className="muted">Drag & drop or browse</span>
                </div>

                <div
                  className={`dropzone ${isDragging ? 'isDragging' : ''}`}
                  onDragEnter={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    setIsDragging(true)
                  }}
                  onDragOver={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    setIsDragging(true)
                  }}
                  onDragLeave={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    setIsDragging(false)
                  }}
                  onDrop={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    setIsDragging(false)
                    const fs = e.dataTransfer.files
                    if (fs && fs.length) onPickFiles(fs)
                  }}
                >
                  <div className="controlsRow">
                    <div className="fileInput">
                      <input
                        type="file"
                        accept="image/*"
                        multiple
                        onChange={(e) => {
                          if (e.target.files) onPickFiles(e.target.files)
                        }}
                      />
                      <span className="muted">Supports HEIC/HEIF via WASM decode</span>
                    </div>

                    <div className="actions">
                      <button className="btn btnPrimary" disabled={!canScrub} onClick={onScrub}>
                        {busy ? 'Scrubbing…' : `Scrub (${items.length})`}
                      </button>
                      <button className="btn" disabled={cleanedCount === 0} onClick={downloadZip}>
                        Download ZIP ({cleanedCount})
                      </button>
                      <button className="btn btnGhost" disabled={items.length === 0 || busy} onClick={resetOutputs}>
                        Reset
                      </button>
                    </div>
                  </div>

                  <div className="formRow">
                    <div className="field">
                      <span className="muted">Output</span>
                      <select
                        className="select"
                        value={outputType}
                        onChange={(e) => setOutputType(e.target.value as any)}
                      >
                        <option value="image/jpeg">JPEG</option>
                        <option value="image/png">PNG</option>
                        <option value="image/webp">WebP</option>
                      </select>
                    </div>

                    <div className="field">
                      <span className="muted">Quality</span>
                      <input
                        className="range"
                        type="range"
                        min={0.1}
                        max={1}
                        step={0.01}
                        value={quality}
                        onChange={(e) => setQuality(Number(e.target.value))}
                        disabled={outputType === 'image/png'}
                      />
                      <span className="muted">{Math.round(quality * 100)}%</span>
                    </div>
                  </div>

                  <div className="muted">
                    Re-encoding strips most metadata. Some platforms may re-tag images on upload—verify by downloading and rechecking.
                  </div>
                </div>

                {error ? (
                  <div className="errorBox">
                    <strong>Error:</strong> {error}
                  </div>
                ) : null}
              </div>

              <div className="panel">
                <div className="panelHeader">
                  <h2 className="panelTitle">Preview</h2>
                  <span className="muted">First original + first cleaned</span>
                </div>

                <div className="preview">
                  <div className="previewBox">
                    <div className="previewBoxHeader">
                      <h3 className="previewTitle">Original</h3>
                    </div>
                    {previewOriginal ? (
                      <img className="img" src={previewOriginal} alt="Original preview" />
                    ) : (
                      <div className="muted">Pick files to see a preview.</div>
                    )}
                  </div>

                  <div className="previewBox">
                    <div className="previewBoxHeader">
                      <h3 className="previewTitle">Cleaned</h3>
                    </div>
                    {previewCleaned ? (
                      <img className="img" src={previewCleaned} alt="Cleaned preview" />
                    ) : (
                      <div className="muted">Run scrub to generate cleaned images.</div>
                    )}
                  </div>
                </div>
              </div>
            </div>

            <div className="panel panelSpacer">
              <div className="panelHeader">
                <h2 className="panelTitle">Batch results</h2>
                <span className="muted">Per-file status and verification</span>
              </div>

              {items.length === 0 ? (
                <div className="muted">No files selected yet.</div>
              ) : (
                <div className="batchList">
                  {items.map((it) => {
                    const badge = badgeFor(it)
                    const findings = buildFindings(it.before)
                    const highlights = keyHighlights(it.before?.exifKeys)
                    return (
                      <div key={it.id} className="item">
                        <div className="itemTop">
                          <div>
                            <div className="itemName">{it.file.name}</div>
                            <div className="itemMeta">
                              <span className={badge.className}>{badge.text}</span>
                              {it.after?.gps ? <span className="badge badgeWarn">GPS</span> : null}
                              {it.after?.make || it.after?.model ? <span className="badge badgeWarn">Device</span> : null}
                              {it.after?.dateTimeOriginal ? (
                                <span className="badge badgeWarn">Timestamp</span>
                              ) : null}
                              {it.error ? <span className="badge badgeErr">{it.error}</span> : null}
                            </div>
                          </div>

                          <div className="actions">
                            <button className="btn" disabled={!it.cleanedBlob} onClick={() => downloadOne(it)}>
                              Download
                            </button>
                          </div>
                        </div>

                        {it.before ? (
                          <div className="edu mt12">
                            <div className="callout">
                              <div className="calloutTitle">What we found (before scrubbing)</div>
                              <div className="findings">
                                {findings.map((f) => (
                                  <span key={f.key} className={`chip ${f.cls}`} title={f.why}>
                                    <strong>{f.title}</strong>
                                    {f.value ? (
                                      <span className="muted">{f.value}</span>
                                    ) : (
                                      <span className="muted">None</span>
                                    )}
                                  </span>
                                ))}
                              </div>
                              <div className="muted mt10">Hover a chip to see why it matters.</div>
                            </div>

                            {highlights.length ? (
                              <div className="callout">
                                <div className="calloutTitle">Detected EXIF keys (highlights)</div>
                                <div className="muted">{highlights.join(', ')}</div>
                              </div>
                            ) : null}
                          </div>
                        ) : null}

                        {(it.before || it.after) && (
                          <div className="details">
                            <details>
                              <summary>Details</summary>
                              <div className="detailsGrid">
                                <div>
                                  <div className="muted detailsTitle">Before</div>
                                  <pre className="json">{JSON.stringify(it.before, null, 2)}</pre>
                                </div>
                                <div>
                                  <div className="muted detailsTitle">After</div>
                                  <pre className="json">{JSON.stringify(it.after, null, 2)}</pre>
                                </div>
                              </div>
                            </details>
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
            </div>

            <div className="panel panelSpacer">
              <div className="panelHeader">
                <h2 className="panelTitle">Metadata glossary</h2>
                <span className="muted">What it is, why it matters, and why people remove it</span>
              </div>

              <div className="dl">
                <div className="dlRow">
                  <div className="dt">GPS / Location</div>
                  <p className="dd">
                    Stores latitude/longitude (sometimes altitude and direction). Useful for personal photo organization, but it can
                    reveal where you live, work, or visit.
                  </p>
                </div>

                <div className="dlRow">
                  <div className="dt">Timestamps (DateTimeOriginal)</div>
                  <p className="dd">
                    Stores when the photo was taken. Harmless for most users, but it can help others build timelines and correlate
                    posts or events.
                  </p>
                </div>

                <div className="dlRow">
                  <div className="dt">Device info (Make / Model)</div>
                  <p className="dd">
                    Identifies the camera/phone model. Alone it’s not your name, but it can narrow your identity and help link files
                    created by the same device.
                  </p>
                </div>

                <div className="dlRow">
                  <div className="dt">Software / Editing history</div>
                  <p className="dd">
                    Indicates which apps exported or edited the file. This can leak workflow details and sometimes correlate images
                    across accounts.
                  </p>
                </div>

                <div className="dlRow">
                  <div className="dt">EXIF (camera metadata bucket)</div>
                  <p className="dd">
                    A structured set of tags embedded in images (especially JPEG/HEIC). It can include GPS, time, device, camera
                    settings, and orientation.
                  </p>
                </div>

                <div className="dlRow">
                  <div className="dt">XMP (Adobe / modern metadata)</div>
                  <p className="dd">
                    Often stores descriptive fields and editing/export history. Some tools embed more information than users expect.
                  </p>
                </div>

                <div className="dlRow">
                  <div className="dt">IPTC (publisher metadata)</div>
                  <p className="dd">
                    Common in journalism/creative workflows; can include author, copyright, caption, and contact fields.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </main>

        <aside className="sidebar">
          <div className="sidebarSticky">
            <div className="panel">
              <div className="panelHeader">
                <h2 className="panelTitle">Sponsored</h2>
                <span className="muted">No popups</span>
              </div>

              <div className="sidebarStack">
                {sponsors.map((s, idx) => (
                  <a
                    key={idx}
                    className="adCard"
                    href={s.href}
                    target={s.href === '#' ? undefined : '_blank'}
                    rel={s.href === '#' ? undefined : 'noreferrer'}
                  >
                    <div className="adTitle">{s.title}</div>
                    <div className="adBody">{s.body}</div>
                  </a>
                ))}
              </div>

              <div className="muted mt10">
                Replace these with your ad network component (e.g. AdSense) or direct sponsor cards.
              </div>
            </div>
          </div>
        </aside>
      </div>
    </div>
  )
}

export default App
