import {
  App,
  Editor,
  EditorPosition,
  MarkdownPostProcessorContext,
  MarkdownRenderChild,
  MarkdownRenderer,
  MarkdownView,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  normalizePath,
  requestUrl,
  setIcon,
} from 'obsidian'

interface MnemoSettings {
  apiKey: string
  language: string
  transcribeModel: string
  saveAudio: boolean
  audioFolder: string
  askForLabel: boolean
  formatWithAi: boolean
  chatModel: string
  liveMode: boolean
  liveChunkSeconds: number
  transcribeDrops: boolean
}

const DEFAULT_SETTINGS: MnemoSettings = {
  apiKey: '',
  language: '',
  transcribeModel: 'gpt-4o-transcribe',
  saveAudio: true,
  audioFolder: 'x/Recordings',
  askForLabel: true,
  formatWithAi: true,
  chatModel: 'gpt-4o-mini',
  liveMode: false,
  liveChunkSeconds: 10,
  transcribeDrops: true,
}

// OpenAI transcription accepts files up to 25 MB; bigger or unsupported files are split into WAV pieces
const MAX_FILE_SIZE_BYTES = 25 * 1024 * 1024
const SEGMENT_SECONDS = 600
const OPENAI_EXTS = new Set(['flac', 'm4a', 'mp3', 'mp4', 'mpeg', 'mpga', 'oga', 'ogg', 'wav', 'webm'])
const AUDIO_EXTS = new Set([...OPENAI_EXTS, 'aac', 'caf', 'opus', 'qta', 'aiff', 'aif', 'mov'])

const FENCE = '```'
const AUDIO_MARK = '--- audio'
const TRANSCRIPT_MARK = '--- transcript'
const SUMMARY_MARK = '--- summary'

const LANGUAGE_RULES = `- The speaker may switch between languages (e.g. English and isiZulu), even mid-sentence.
- Never use triple backticks.`

const FORMAT_PROMPT = `You tidy raw speech-to-text transcripts for Obsidian notes.
Return JSON: {"transcript": string}.
- Keep the full transcript faithfully, with punctuation and paragraphs fixed. Do not drop content.
- If the content involves maths, physics, chemistry or other science, write every spoken formula, equation,
  unit, symbol or chemical formula as LaTeX: inline $...$ and display $$...$$ (on their own lines). E.g.
  "x squared plus two x" -> $x^2 + 2x$, "integral from zero to one of f of x dx" -> $\\int_0^1 f(x)\\,dx$.
- Keep every passage in the language it was spoken — never translate. Fix obvious mis-hearings using the
  correct spelling in that language.
${LANGUAGE_RULES}`

const SUMMARY_PROMPT = `You write study-note summaries of lesson or meeting transcripts for Obsidian.
Return JSON: {"summary": string} — concise Markdown (headings/bullets, key definitions, worked steps).
- Write maths and science notation as LaTeX: inline $...$ and display $$...$$.
- Write the summary in English, keeping important non-English terms in the original with a short gloss,
  e.g. "isenzo (verb)".
${LANGUAGE_RULES}`

interface MnemoBlock {
  audio: string
  transcript: string
  summary: string
}

function blockBody(b: MnemoBlock) {
  const audio = b.audio ? `${AUDIO_MARK}\n${b.audio}\n` : ''
  return `${audio}${TRANSCRIPT_MARK}\n${b.transcript.trim()}\n${SUMMARY_MARK}\n${b.summary.trim()}\n`
}

function buildBlock(b: MnemoBlock) {
  return `${FENCE}mnemo\n${blockBody(b)}${FENCE}\n`
}

function parseBlock(source: string): MnemoBlock {
  const out: MnemoBlock = { audio: '', transcript: '', summary: '' }
  if (!source.includes(TRANSCRIPT_MARK)) return { ...out, transcript: source.trim() }
  const marks: Record<string, keyof MnemoBlock> = {
    [AUDIO_MARK]: 'audio',
    [TRANSCRIPT_MARK]: 'transcript',
    [SUMMARY_MARK]: 'summary',
  }
  let key: keyof MnemoBlock | null = null
  for (const line of source.split('\n')) {
    const mark = marks[line.trim()]
    if (mark) key = mark
    else if (key) out[key] += line + '\n'
  }
  return { audio: out.audio.trim(), transcript: out.transcript.trim(), summary: out.summary.trim() }
}

// Model output goes inside a code fence, so it can't contain one
function noFences(t: unknown) {
  return String(t ?? '').replace(/```/g, "'".repeat(3))
}

function extOf(name: string) {
  return name.split('.').pop()?.toLowerCase() ?? ''
}

function isAudioFile(f: File) {
  return f.type.startsWith('audio/') || AUDIO_EXTS.has(extOf(f.name))
}

// Decode any audio the app can play, downmix to 16 kHz mono, and cut it into WAV pieces under 25 MB
async function splitToWav(audio: ArrayBuffer, seconds = SEGMENT_SECONDS): Promise<ArrayBuffer[]> {
  const ctx = new AudioContext({ sampleRate: 16000 })
  let buf: AudioBuffer
  try {
    buf = await ctx.decodeAudioData(audio.slice(0))
  } catch {
    throw new Error('Could not read this audio format. Try exporting it as .m4a or .mp3.')
  } finally {
    ctx.close()
  }
  const mono = new Float32Array(buf.length)
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const data = buf.getChannelData(c)
    for (let i = 0; i < data.length; i++) mono[i] += data[i] / buf.numberOfChannels
  }
  const step = seconds * buf.sampleRate
  const out: ArrayBuffer[] = []
  for (let i = 0; i < mono.length; i += step) out.push(encodeWav(mono.subarray(i, i + step), buf.sampleRate))
  return out
}

function encodeWav(samples: Float32Array, rate: number): ArrayBuffer {
  const view = new DataView(new ArrayBuffer(44 + samples.length * 2))
  const str = (o: number, t: string) => [...t].forEach((ch, i) => view.setUint8(o + i, ch.charCodeAt(0)))
  str(0, 'RIFF')
  view.setUint32(4, 36 + samples.length * 2, true)
  str(8, 'WAVEfmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, rate, true)
  view.setUint32(28, rate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  str(36, 'data')
  view.setUint32(40, samples.length * 2, true)
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(44 + i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true)
  }
  return view.buffer
}

interface AudioSource {
  name: string
  type: string
  load: () => Promise<ArrayBuffer>
  // Already in the vault: link it instead of saving a copy
  vaultPath?: string
}

export default class MnemoPlugin extends Plugin {
  settings: MnemoSettings = DEFAULT_SETTINGS
  private stream: MediaStream | null = null
  private mimeType = ''
  // Full-length recorder: produces the saved audio file (and the transcript in normal mode)
  private recorder: MediaRecorder | null = null
  private chunks: Blob[] = []
  // Live mode: a separate recorder restarted every N seconds so each segment is a standalone file
  private liveRecorder: MediaRecorder | null = null
  private liveTimer: number | null = null
  private liveQueue: Promise<void> = Promise.resolve()
  private liveEditor: Editor | null = null
  private livePos: EditorPosition | null = null
  private liveText = ''
  private liveBlockStart = 0
  private startedAt = 0
  private timer: number | null = null
  private statusEl: HTMLElement | null = null
  private ribbonEl: HTMLElement | null = null

  async onload() {
    await this.loadSettings()

    this.ribbonEl = this.addRibbonIcon('mic', 'Start voice transcription', () => this.toggle())
    this.statusEl = this.addStatusBarItem()

    this.addCommand({
      id: 'toggle-recording',
      name: 'Start / stop voice transcription',
      icon: 'mic',
      callback: () => this.toggle(),
    })

    this.addCommand({
      id: 'toggle-live-recording',
      name: 'Start / stop live transcription',
      icon: 'audio-lines',
      callback: () => this.toggle(true),
    })

    this.addCommand({
      id: 'transcribe-file',
      name: 'Transcribe audio file…',
      icon: 'file-audio',
      editorCallback: editor => this.pickFiles(editor),
    })

    // Drop audio (e.g. from Voice Memos or Finder) onto a note to transcribe it there
    this.registerEvent(
      this.app.workspace.on('editor-drop', (evt, editor) => {
        if (!this.settings.transcribeDrops || evt.defaultPrevented) return
        const files = Array.from(evt.dataTransfer?.files ?? []).filter(isAudioFile)
        if (!files.length) return
        evt.preventDefault()
        // CodeMirror knows where the pointer is; fall back to the cursor
        const at = (editor as any).cm?.posAtCoords?.({ x: evt.clientX, y: evt.clientY })
        this.transcribeInto(editor, files.map(fileSource), typeof at === 'number' ? at : undefined)
      }),
    )

    // Right-click an audio file already in the vault
    this.registerEvent(
      this.app.workspace.on('file-menu', (menu, file) => {
        if (!(file instanceof TFile) || !AUDIO_EXTS.has(file.extension)) return
        menu.addItem(item =>
          item
            .setTitle('Transcribe with Mnemo')
            .setIcon('mic')
            .onClick(() => {
              const editor = this.app.workspace.getActiveViewOfType(MarkdownView)?.editor
              if (!editor) return new Notice('Mnemo: open the note the transcript should go in first.')
              this.transcribeInto(editor, [
                {
                  name: file.name,
                  type: `audio/${file.extension}`,
                  load: () => this.app.vault.readBinary(file),
                  vaultPath: file.path,
                },
              ])
            }),
        )
      }),
    )

    this.registerMarkdownCodeBlockProcessor('mnemo', (src, el, ctx) => this.renderBlock(src, el, ctx))

    this.addSettingTab(new MnemoSettingTab(this.app, this))
  }

  private renderBlock(source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext) {
    const block = parseBlock(source)
    const child = new MarkdownRenderChild(el)
    ctx.addChild(child)

    const root = el.createDiv({ cls: 'mnemo-block' })
    const bar = root.createDiv({ cls: 'mnemo-tabs' })
    const tabs: HTMLElement[] = []
    const panes: HTMLElement[] = []
    const copyText = [block.transcript, block.audio, block.summary]
    const addTab = (name: string) => {
      const i = tabs.length
      const tab = bar.createEl('button', { text: name, cls: 'mnemo-tab' })
      const pane = root.createDiv({ cls: 'mnemo-pane markdown-rendered' })
      tab.onclick = () => {
        tabs.forEach((t, j) => t.toggleClass('is-active', i === j))
        panes.forEach((p, j) => p.toggle(i === j))
      }
      tabs.push(tab)
      panes.push(pane)
      return pane
    }

    MarkdownRenderer.render(this.app, block.transcript, addTab('Transcript'), ctx.sourcePath, child)

    const audioPane = addTab('Audio')
    const audioFile = block.audio ? this.app.vault.getAbstractFileByPath(block.audio) : null
    if (audioFile instanceof TFile) {
      audioPane.createEl('audio', {
        cls: 'mnemo-audio',
        attr: { controls: '', preload: 'metadata', src: this.app.vault.getResourcePath(audioFile) },
      })
      const link = audioPane.createEl('a', { text: audioFile.name, cls: 'mnemo-audio-name' })
      link.onclick = () => this.app.workspace.getLeaf('tab').openFile(audioFile)
    } else {
      audioPane.createEl('p', {
        text: block.audio ? `Audio file not found: ${block.audio}` : 'No audio saved with this transcript.',
        cls: 'mnemo-empty',
      })
    }

    const summaryPane = addTab('Summary')
    if (block.summary) {
      MarkdownRenderer.render(this.app, block.summary, summaryPane, ctx.sourcePath, child)
    } else if (this.recorder || !block.transcript || block.transcript.startsWith('_Transcribing ')) {
      summaryPane.createEl('p', { text: 'You can summarise once transcription finishes.', cls: 'mnemo-empty' })
    } else {
      // Only spend the user's credits when they ask for a summary
      summaryPane.createEl('p', { text: 'No summary yet.', cls: 'mnemo-empty' })
      const btn = summaryPane.createEl('button', { text: 'Generate summary', cls: 'mod-cta' })
      btn.onclick = async () => {
        btn.disabled = true
        btn.setText('Summarising…')
        try {
          const summary = await this.summarise(block.transcript)
          await this.updateBlock(ctx, el, source, { ...block, summary })
        } catch (err: any) {
          new Notice(`Mnemo: summary failed (${err?.message ?? 'error'}).`, 8000)
          btn.disabled = false
          btn.setText('Generate summary')
        }
      }
    }

    const copy = bar.createEl('button', { text: 'Copy', cls: 'mnemo-copy' })
    copy.onclick = () => {
      const active = tabs.findIndex(t => t.hasClass('is-active'))
      navigator.clipboard.writeText(copyText[active])
      new Notice('Copied')
    }
    tabs[0].click()
  }

  // Rewrite this block's contents in the note
  private async updateBlock(ctx: MarkdownPostProcessorContext, el: HTMLElement, source: string, b: MnemoBlock) {
    const file = this.app.vault.getAbstractFileByPath(ctx.sourcePath)
    if (!(file instanceof TFile)) throw new Error('note not found')
    const info = ctx.getSectionInfo(el)
    const body = blockBody(b).trimEnd()
    await this.app.vault.process(file, data => {
      const lines = data.split('\n')
      if (info && lines[info.lineStart]?.startsWith(FENCE + 'mnemo') && lines[info.lineEnd]?.startsWith(FENCE)) {
        lines.splice(info.lineStart + 1, info.lineEnd - info.lineStart - 1, ...body.split('\n'))
        return lines.join('\n')
      }
      const at = data.indexOf(source.trim())
      if (at === -1) throw new Error('block changed — try again')
      return data.slice(0, at) + body + data.slice(at + source.trim().length)
    })
  }

  // ---- Audio files (drop, picker, vault) ----

  private pickFiles(editor: Editor) {
    const input = document.body.createEl('input', {
      attr: { type: 'file', multiple: '', accept: 'audio/*,' + [...AUDIO_EXTS].map(e => '.' + e).join(',') },
    })
    input.style.display = 'none'
    input.onchange = () => {
      const files = Array.from(input.files ?? []).filter(isAudioFile)
      input.remove()
      if (files.length) this.transcribeInto(editor, files.map(fileSource))
    }
    input.click()
  }

  private async transcribeInto(editor: Editor, sources: AudioSource[], offset?: number) {
    if (!this.settings.apiKey) {
      new Notice('Mnemo: add your OpenAI API key in Settings → Mnemo Voice Transcriber.')
      return
    }
    // Put placeholders on their own lines at the drop point, then fill each one in turn
    const pos = editor.offsetToPos(offset ?? editor.posToOffset(editor.getCursor()))
    const lineText = editor.getLine(pos.line)
    const id = Date.now().toString(36)
    const placeholders = sources.map(
      (src, i) => `${FENCE}mnemo\n${TRANSCRIPT_MARK}\n_Transcribing ${src.name}… (${id}-${i})_\n${FENCE}\n`,
    )
    editor.replaceRange((lineText.trim() ? '\n' : '') + placeholders.join(''), { line: pos.line, ch: lineText.length })

    for (const [i, src] of sources.entries()) {
      let result = ''
      try {
        const audio = await src.load()
        const ext = extOf(src.name)
        let path = src.vaultPath ?? ''
        if (!path && this.settings.saveAudio) {
          const name = src.name.replace(/\.[^.]+$/, '')
          const label = this.settings.askForLabel ? await new LabelModal(this.app, name).ask() : name
          path = await this.saveAudioFile(audio, label, ext)
        }
        const raw = await this.transcribeAudio(audio, ext, src.type || `audio/${ext}`)
        this.progress('sparkles', 'Tidying…')
        result = buildBlock({ audio: path, transcript: await this.format(raw), summary: '' })
        new Notice(`Mnemo: ${src.name} transcribed.`)
      } catch (err: any) {
        new Notice(`Mnemo: ${src.name} — ${err?.message ?? 'transcription failed'}`, 8000)
        console.error('Mnemo file transcription error', err)
      }
      const at = editor.getValue().indexOf(placeholders[i])
      if (at !== -1) {
        editor.replaceRange(result, editor.offsetToPos(at), editor.offsetToPos(at + placeholders[i].length))
      } else if (result) {
        editor.replaceSelection(result)
      }
    }
    this.progress('', '')
  }

  // Send as-is when OpenAI accepts it, otherwise split into WAV pieces and join the text
  private async transcribeAudio(audio: ArrayBuffer, ext: string, type: string): Promise<string> {
    if (audio.byteLength <= MAX_FILE_SIZE_BYTES && OPENAI_EXTS.has(ext)) {
      this.progress('loader', 'Transcribing…')
      return this.transcribe(audio, `audio.${ext}`, type)
    }
    this.progress('loader', 'Preparing audio…')
    const pieces = await splitToWav(audio)
    let text = ''
    for (const [i, piece] of pieces.entries()) {
      this.progress('loader', `Transcribing ${i + 1}/${pieces.length}…`)
      const t = await this.transcribe(piece, 'audio.wav', 'audio/wav', text)
      text += (text && t ? ' ' : '') + t
    }
    return text
  }

  // Status text that never overwrites an active recording's timer
  private progress(icon: string, text: string) {
    if (this.recorder?.state === 'recording') return
    if (text) this.setStatus(icon, text)
    else this.statusEl?.setText('')
  }

  onunload() {
    this.cleanup()
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData())
  }

  async saveSettings() {
    await this.saveData(this.settings)
  }

  private toggle(live = this.settings.liveMode) {
    if (this.recorder?.state === 'recording') this.stop()
    else this.start(live)
  }

  private async start(live: boolean) {
    if (!this.settings.apiKey) {
      new Notice('Mnemo: add your OpenAI API key in Settings → Mnemo Voice Transcriber.')
      return
    }

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch {
      new Notice('Mnemo: microphone access denied.')
      return
    }

    // Prefer Opus for much smaller files (fits more minutes under Whisper's 25 MB cap)
    this.mimeType =
      ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find(t => MediaRecorder.isTypeSupported(t)) ?? ''

    const recorder = this.newRecorder()
    this.chunks = []
    recorder.ondataavailable = e => {
      if (e.data.size > 0) this.chunks.push(e.data)
    }
    recorder.onstop = () => this.finish(live)
    recorder.start(1000)
    this.recorder = recorder

    if (live) this.startLive()

    this.startedAt = Date.now()
    this.ribbonEl?.addClass('mnemo-recording')
    this.ribbonEl?.setAttr('aria-label', 'Stop voice transcription')
    this.updateStatus()
    this.timer = window.setInterval(() => this.updateStatus(), 1000)
    new Notice(live ? 'Mnemo: live transcription on…' : 'Mnemo: recording…')
  }

  private stop() {
    this.stopLiveSegment()
    this.clearLiveTimer()
    this.recorder?.stop()
    this.releaseMic()
    this.clearTimer()
    this.setStatus('loader', 'Transcribing…')
  }

  private newRecorder() {
    return new MediaRecorder(this.stream!, this.mimeType ? { mimeType: this.mimeType } : undefined)
  }

  private get ext() {
    return this.mimeType.includes('mp4') ? 'm4a' : 'webm'
  }

  // ---- Live mode ----

  private startLive() {
    const editor = this.app.workspace.getActiveViewOfType(MarkdownView)?.editor ?? null
    if (!editor) {
      new Notice('Mnemo: open a note first — live text goes to the cursor.')
      return
    }
    const cursor = editor.getCursor()
    this.liveBlockStart = editor.posToOffset(cursor)
    const head = `${FENCE}mnemo\n${TRANSCRIPT_MARK}\n`
    editor.replaceRange(head + `\n${SUMMARY_MARK}\n${FENCE}\n`, cursor)
    this.liveEditor = editor
    this.livePos = editor.offsetToPos(this.liveBlockStart + head.length)
    this.liveText = ''
    this.liveQueue = Promise.resolve()

    this.startLiveSegment()
    this.liveTimer = window.setInterval(() => {
      this.stopLiveSegment()
      this.startLiveSegment()
    }, Math.max(3, this.settings.liveChunkSeconds) * 1000)
  }

  private startLiveSegment() {
    const rec = this.newRecorder()
    const parts: Blob[] = []
    rec.ondataavailable = e => {
      if (e.data.size > 0) parts.push(e.data)
    }
    rec.onstop = () => {
      const blob = new Blob(parts, { type: rec.mimeType })
      // Transcribe segments in order so text appears in sequence
      this.liveQueue = this.liveQueue.then(() => this.transcribeLiveSegment(blob))
    }
    rec.start()
    this.liveRecorder = rec
  }

  private stopLiveSegment() {
    if (this.liveRecorder?.state === 'recording') this.liveRecorder.stop()
    this.liveRecorder = null
  }

  private async transcribeLiveSegment(blob: Blob) {
    if (blob.size < 2000) return // silence / near-empty segment
    try {
      const text = await this.transcribe(await blob.arrayBuffer(), `segment.${this.ext}`, blob.type, this.liveText)
      if (!text || !this.liveEditor || !this.livePos) return
      const chunk = (this.liveText ? ' ' : '') + text
      this.liveEditor.replaceRange(chunk, this.livePos)
      const offset = this.liveEditor.posToOffset(this.livePos) + chunk.length
      this.livePos = this.liveEditor.offsetToPos(offset)
      this.liveText += chunk
    } catch (err: any) {
      new Notice(`Mnemo (live): ${err?.message ?? 'segment failed'}`, 5000)
    }
  }

  private clearLiveTimer() {
    if (this.liveTimer !== null) window.clearInterval(this.liveTimer)
    this.liveTimer = null
  }

  // ---- Finishing ----

  private async finish(live: boolean) {
    try {
      const blob = new Blob(this.chunks, { type: this.mimeType || 'audio/webm' })
      const audio = await blob.arrayBuffer()
      const wantAudio = this.settings.saveAudio
      const label = wantAudio && this.settings.askForLabel ? await new LabelModal(this.app).ask() : null
      const path = wantAudio ? await this.saveAudioFile(audio, label, this.ext) : ''

      if (live) {
        await this.liveQueue
        const editor = this.liveEditor
        if (!editor || !this.livePos) return
        this.setStatus('sparkles', 'Tidying…')
        const transcript = await this.format(this.liveText)
        // Replace the live skeleton block (start .. closing fence) with the final one
        const from = editor.offsetToPos(this.liveBlockStart)
        const closeIdx = editor.getValue().indexOf(`\n${FENCE}`, editor.posToOffset(this.livePos))
        const to = editor.offsetToPos(closeIdx + FENCE.length + 2)
        editor.replaceRange(buildBlock({ audio: path, transcript, summary: '' }), from, to)
        new Notice('Mnemo: live transcription finished.')
        return
      }

      const raw = await this.transcribeAudio(audio, this.ext, blob.type)
      this.setStatus('sparkles', 'Tidying…')
      this.insert(buildBlock({ audio: path, transcript: await this.format(raw), summary: '' }))
      new Notice('Mnemo: transcript added.')
    } catch (err: any) {
      new Notice(`Mnemo: ${err?.message ?? 'transcription failed'}`, 8000)
      console.error('Mnemo transcription error', err)
    } finally {
      this.cleanup()
    }
  }

  private async transcribe(audio: ArrayBuffer, filename: string, type: string, prompt = ''): Promise<string> {
    // Build multipart body by hand: requestUrl bypasses CORS but doesn't accept FormData
    const boundary = '----mnemo' + Math.random().toString(16).slice(2)
    const enc = new TextEncoder()
    const field = (name: string, value: string) =>
      enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`)

    const parts: Uint8Array[] = [field('model', this.settings.transcribeModel || 'whisper-1')]
    if (this.settings.language) parts.push(field('language', this.settings.language))
    // Previous text as context keeps live segments consistent across boundaries
    if (prompt) parts.push(field('prompt', prompt.slice(-500)))
    parts.push(
      enc.encode(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${type}\r\n\r\n`,
      ),
      new Uint8Array(audio),
      enc.encode(`\r\n--${boundary}--\r\n`),
    )

    const body = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
    let offset = 0
    for (const p of parts) {
      body.set(p, offset)
      offset += p.length
    }

    const res = await requestUrl({
      url: 'https://api.openai.com/v1/audio/transcriptions',
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.settings.apiKey}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
      },
      body: body.buffer,
      throw: false,
    })

    if (res.status === 401) throw new Error('Invalid OpenAI API key.')
    if (res.status === 429) throw new Error('OpenAI rate limit or quota exceeded.')
    if (res.status >= 400) {
      const msg = res.json?.error?.message ?? res.text.slice(0, 200)
      throw new Error(`OpenAI error (${res.status}): ${msg}`)
    }
    return (res.json.text as string).trim()
  }

  private async saveAudioFile(audio: ArrayBuffer, label: string | null, ext: string): Promise<string> {
    const folder = normalizePath(this.settings.audioFolder || 'x/Recordings')
    if (!this.app.vault.getAbstractFileByPath(folder)) await this.app.vault.createFolder(folder)

    const stamp = window.moment().format('YYYY-MM-DD HHmm')
    const clean = (label ?? '').replace(/[\\/:*?"<>|#^[\]]/g, '').trim()
    const base = clean ? `${stamp} ${clean}` : `${stamp} Recording`

    let path = normalizePath(`${folder}/${base}.${ext}`)
    for (let i = 2; this.app.vault.getAbstractFileByPath(path); i++) {
      path = normalizePath(`${folder}/${base} ${i}.${ext}`)
    }
    await this.app.vault.createBinary(path, audio)
    return path
  }

  private async chat(system: string, user: string): Promise<any> {
    const res = await requestUrl({
      url: 'https://api.openai.com/v1/chat/completions',
      method: 'POST',
      headers: { Authorization: `Bearer ${this.settings.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.settings.chatModel || 'gpt-4o-mini',
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
      throw: false,
    })
    if (res.status >= 400) throw new Error(res.json?.error?.message ?? `HTTP ${res.status}`)
    return JSON.parse(res.json.choices[0].message.content)
  }

  // Clean up the transcript and add LaTeX for maths/science
  private async format(raw: string): Promise<string> {
    if (!raw.trim() || !this.settings.formatWithAi) return raw
    try {
      const out = await this.chat(FORMAT_PROMPT, raw)
      return noFences(out.transcript) || raw
    } catch (err: any) {
      // Never lose the transcript because the tidy step failed
      new Notice(`Mnemo: formatting failed (${err?.message ?? 'error'}) — raw transcript kept.`, 8000)
      return raw
    }
  }

  // Only runs when the user presses "Generate summary"
  private async summarise(transcript: string): Promise<string> {
    const summary = noFences(await this.chat(SUMMARY_PROMPT, transcript).then(o => o.summary)).trim()
    if (!summary) throw new Error('empty summary')
    return summary
  }

  private insert(text: string) {

    const editor = this.app.workspace.getActiveViewOfType(MarkdownView)?.editor
    if (editor) {
      editor.replaceSelection(text)
    } else {
      // No open note: keep the transcript instead of losing it
      navigator.clipboard.writeText(text)
      new Notice('Mnemo: no note open — transcript copied to clipboard.', 8000)
    }
  }

  private updateStatus() {
    const s = Math.floor((Date.now() - this.startedAt) / 1000)
    const live = this.liveEditor ? ' live' : ''
    this.setStatus('mic', `${live ? 'Live ' : ''}${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}`, true)
  }

  // Status bar: Obsidian icon + text (no emoji)
  private setStatus(icon: string, text: string, recording = false) {
    if (!this.statusEl) return
    this.statusEl.empty()
    this.statusEl.addClass('mnemo-status')
    this.statusEl.toggleClass('mnemo-status-recording', recording)
    setIcon(this.statusEl.createSpan({ cls: 'mnemo-status-icon' }), icon)
    this.statusEl.createSpan({ text })
  }

  private releaseMic() {
    this.stream?.getTracks().forEach(t => t.stop())
  }

  private clearTimer() {
    if (this.timer !== null) window.clearInterval(this.timer)
    this.timer = null
  }

  private cleanup() {
    this.clearTimer()
    this.clearLiveTimer()
    for (const rec of [this.recorder, this.liveRecorder]) {
      if (rec?.state === 'recording') {
        rec.onstop = null
        rec.stop()
      }
    }
    this.releaseMic()
    this.stream = null
    this.recorder = null
    this.liveRecorder = null
    this.liveEditor = null
    this.livePos = null
    this.chunks = []
    this.statusEl?.setText('')
    this.ribbonEl?.removeClass('mnemo-recording')
    this.ribbonEl?.setAttr('aria-label', 'Start voice transcription')
  }
}

class LabelModal extends Modal {
  private resolve: (v: string | null) => void = () => {}
  constructor(app: App, private value = '') {
    super(app)
  }

  ask(): Promise<string | null> {
    return new Promise(resolve => {
      this.resolve = resolve
      this.open()
    })
  }

  onOpen() {
    this.titleEl.setText('Label this recording')
    new Setting(this.contentEl).setName('Label').addText(t => {
      t.setPlaceholder('e.g. Lecture — Thermodynamics week 3').setValue(this.value).onChange(v => (this.value = v))
      t.inputEl.addEventListener('keydown', e => {
        if (e.key === 'Enter') {
          e.preventDefault()
          this.close()
        }
      })
      window.setTimeout(() => t.inputEl.focus(), 0)
    })
    new Setting(this.contentEl).addButton(b => b.setButtonText('Save').setCta().onClick(() => this.close()))
  }

  onClose() {
    this.contentEl.empty()
    this.resolve(this.value.trim() || null)
  }
}

class MnemoSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: MnemoPlugin) {
    super(app, plugin)
  }

  display() {
    const { containerEl } = this
    containerEl.empty()
    const s = this.plugin.settings
    const save = () => this.plugin.saveSettings()

    new Setting(containerEl)
      .setName('OpenAI API key')
      .setDesc('Stored locally in this vault’s plugin data. Used only for Whisper transcription.')
      .addText(t => {
        t.inputEl.type = 'password'
        t.setPlaceholder('sk-…')
          .setValue(s.apiKey)
          .onChange(async v => {
            s.apiKey = v.trim()
            await save()
          })
      })

    new Setting(containerEl)
      .setName('Language')
      .setDesc('ISO-639-1 code (e.g. en, zu). Leave blank to auto-detect — best for lessons mixing languages, ideally with live mode so each chunk is detected separately.')
      .addText(t =>
        t.setValue(s.language).onChange(async v => {
          s.language = v.trim()
          await save()
        }),
      )

    new Setting(containerEl)
      .setName('Transcription model')
      .setDesc('gpt-4o-transcribe handles switching between languages (e.g. English ↔ isiZulu) best.')
      .addDropdown(d =>
        d
          .addOption('gpt-4o-transcribe', 'gpt-4o-transcribe (best for mixed languages)')
          .addOption('gpt-4o-mini-transcribe', 'gpt-4o-mini-transcribe (cheaper)')
          .addOption('whisper-1', 'whisper-1')
          .setValue(s.transcribeModel)
          .onChange(async v => {
            s.transcribeModel = v
            await save()
          }),
      )

    new Setting(containerEl)
      .setName('AI formatting')
      .setDesc('Tidies the transcript and writes maths/science as LaTeX. Summaries are only made when you press "Generate summary".')
      .addToggle(t =>
        t.setValue(s.formatWithAi).onChange(async v => {
          s.formatWithAi = v
          await save()
        }),
      )

    new Setting(containerEl)
      .setName('Summary model')
      .setDesc('OpenAI chat model used for formatting and summaries.')
      .addText(t =>
        t.setValue(s.chatModel).onChange(async v => {
          s.chatModel = v.trim()
          await save()
        }),
      )

    containerEl.createEl('h3', { text: 'Live transcription' })

    new Setting(containerEl)
      .setName('Live mode by default')
      .setDesc('Ribbon icon writes text as you speak. The "live" command works regardless.')
      .addToggle(t =>
        t.setValue(s.liveMode).onChange(async v => {
          s.liveMode = v
          await save()
        }),
      )

    new Setting(containerEl)
      .setName('Live chunk length (seconds)')
      .setDesc('Shorter = faster text, slightly less accurate at chunk boundaries.')
      .addSlider(sl =>
        sl
          .setLimits(3, 30, 1)
          .setValue(s.liveChunkSeconds)
          .setDynamicTooltip()
          .onChange(async v => {
            s.liveChunkSeconds = v
            await save()
          }),
      )

    containerEl.createEl('h3', { text: 'Audio files' })

    new Setting(containerEl)
      .setName('Transcribe dropped audio')
      .setDesc('Drag an audio file (e.g. from Voice Memos or Finder) onto a note to transcribe it there. Turn off to embed dropped audio normally.')
      .addToggle(t =>
        t.setValue(s.transcribeDrops).onChange(async v => {
          s.transcribeDrops = v
          await save()
        }),
      )

    new Setting(containerEl)
      .setName('Save audio to vault')
      .setDesc('Keep the recording and embed it with the transcript.')
      .addToggle(t =>
        t.setValue(s.saveAudio).onChange(async v => {
          s.saveAudio = v
          await save()
        }),
      )

    new Setting(containerEl)
      .setName('Ask for a label')
      .setDesc('Name each recording when you stop. Files are saved as "YYYY-MM-DD HHmm <label>".')
      .addToggle(t =>
        t.setValue(s.askForLabel).onChange(async v => {
          s.askForLabel = v
          await save()
        }),
      )

    new Setting(containerEl)
      .setName('Audio folder')
      .addText(t =>
        t.setValue(s.audioFolder).onChange(async v => {
          s.audioFolder = v.trim()
          await save()
        }),
      )
  }
}

function fileSource(f: File): AudioSource {
  return { name: f.name, type: f.type, load: () => f.arrayBuffer() }
}
