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
  normalizePath,
  requestUrl,
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
}

// OpenAI Whisper accepts files up to 25 MB
const MAX_FILE_SIZE_BYTES = 25 * 1024 * 1024

const FENCE = '```'
const TRANSCRIPT_MARK = '--- transcript'
const SUMMARY_MARK = '--- summary'

const FORMAT_PROMPT = `You turn raw speech-to-text transcripts into study notes for Obsidian.
Return JSON: {"transcript": string, "summary": string}.
- "transcript": the full transcript, faithfully, with punctuation and paragraphs fixed. Do not drop content.
- "summary": a concise Markdown summary (headings/bullets, key definitions, worked steps).
- If the content involves maths, physics, chemistry or other science, write every spoken formula, equation,
  unit, symbol or chemical formula as LaTeX: inline $...$ and display $$...$$ (on their own lines). E.g.
  "x squared plus two x" -> $x^2 + 2x$, "integral from zero to one of f of x dx" -> $\\int_0^1 f(x)\\,dx$.
- The speaker may switch between languages (e.g. English and isiZulu), even mid-sentence. Keep every passage
  in the language it was spoken — never translate the transcript. Fix obvious mis-hearings using the correct
  spelling in that language.
- Write the summary in English, keeping important non-English terms in the original with a short gloss,
  e.g. "isenzo (verb)".
- Never use triple backticks.`

interface MnemoBlock {
  transcript: string
  summary: string
}

function buildBlock(b: MnemoBlock) {
  return `${FENCE}mnemo\n${TRANSCRIPT_MARK}\n${b.transcript.trim()}\n${SUMMARY_MARK}\n${b.summary.trim()}\n${FENCE}\n`
}

function parseBlock(source: string): MnemoBlock {
  const t = source.indexOf(TRANSCRIPT_MARK)
  const m = source.indexOf(SUMMARY_MARK)
  if (t === -1) return { transcript: source.trim(), summary: '' }
  const end = m === -1 ? source.length : m
  return {
    transcript: source.slice(t + TRANSCRIPT_MARK.length, end).trim(),
    summary: m === -1 ? '' : source.slice(m + SUMMARY_MARK.length).trim(),
  }
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

    this.registerMarkdownCodeBlockProcessor('mnemo', (src, el, ctx) => this.renderBlock(src, el, ctx))

    this.addSettingTab(new MnemoSettingTab(this.app, this))
  }

  private renderBlock(source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext) {
    const block = parseBlock(source)
    const child = new MarkdownRenderChild(el)
    ctx.addChild(child)

    const root = el.createDiv({ cls: 'mnemo-block' })
    const bar = root.createDiv({ cls: 'mnemo-tabs' })
    const panes: HTMLElement[] = []
    const tabs: HTMLElement[] = []
    const entries: [string, string][] = [
      ['Transcript', block.transcript],
      ['Summary', block.summary || (this.recorder ? '_Summary appears when recording stops…_' : '_No summary._')],
    ]
    entries.forEach(([name, md], i) => {
      const tab = bar.createEl('button', { text: name, cls: 'mnemo-tab' })
      const pane = root.createDiv({ cls: 'mnemo-pane markdown-rendered' })
      MarkdownRenderer.render(this.app, md, pane, ctx.sourcePath, child)
      tab.onclick = () => {
        tabs.forEach((t, j) => t.toggleClass('is-active', i === j))
        panes.forEach((p, j) => p.toggle(i === j))
      }
      tabs.push(tab)
      panes.push(pane)
    })
    const copy = bar.createEl('button', { text: 'Copy', cls: 'mnemo-copy' })
    copy.onclick = () => {
      const active = tabs.findIndex(t => t.hasClass('is-active'))
      navigator.clipboard.writeText(entries[active][1])
      new Notice('Copied')
    }
    tabs[0].click()
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
    this.statusEl?.setText('🎙 Transcribing…')
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

      if (live) {
        await this.liveQueue
        const editor = this.liveEditor
        if (!editor || !this.livePos) return
        const audioLink = wantAudio ? await this.saveAudioFile(audio, label) : ''
        this.statusEl?.setText('🎙 Summarising…')
        const block = await this.format(this.liveText)
        // Replace the live skeleton block (start .. closing fence) with the final one
        const from = editor.offsetToPos(this.liveBlockStart)
        const closeIdx = editor.getValue().indexOf(`\n${FENCE}`, editor.posToOffset(this.livePos))
        const to = editor.offsetToPos(closeIdx + FENCE.length + 2)
        editor.replaceRange((audioLink ? audioLink + '\n' : '') + buildBlock(block), from, to)
        new Notice('Mnemo: live transcription finished.')
        return
      }

      if (blob.size > MAX_FILE_SIZE_BYTES) {
        throw new Error(
          `Recording is ${(blob.size / 1024 / 1024).toFixed(1)} MB; Whisper's limit is 25 MB. Try live mode for long sessions.`,
        )
      }

      const audioLink = wantAudio ? await this.saveAudioFile(audio, label) : ''
      const raw = await this.transcribe(audio, `recording.${this.ext}`, blob.type)
      this.statusEl?.setText('🎙 Summarising…')
      this.insert(buildBlock(await this.format(raw)), audioLink)
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

  private async saveAudioFile(audio: ArrayBuffer, label: string | null): Promise<string> {
    const folder = normalizePath(this.settings.audioFolder || 'x/Recordings')
    if (!this.app.vault.getAbstractFileByPath(folder)) await this.app.vault.createFolder(folder)

    const stamp = window.moment().format('YYYY-MM-DD HHmm')
    const clean = (label ?? '').replace(/[\\/:*?"<>|#^[\]]/g, '').trim()
    const base = clean ? `${stamp} ${clean}` : `${stamp} Recording`

    let path = normalizePath(`${folder}/${base}.${this.ext}`)
    for (let i = 2; this.app.vault.getAbstractFileByPath(path); i++) {
      path = normalizePath(`${folder}/${base} ${i}.${this.ext}`)
    }
    await this.app.vault.createBinary(path, audio)
    return `![[${path}]]`
  }

  // Clean up the transcript, add LaTeX for maths/science, and write a summary
  private async format(raw: string): Promise<MnemoBlock> {
    if (!raw.trim()) return { transcript: '', summary: '' }
    if (!this.settings.formatWithAi) return { transcript: raw, summary: '' }
    try {
      const res = await requestUrl({
        url: 'https://api.openai.com/v1/chat/completions',
        method: 'POST',
        headers: { Authorization: `Bearer ${this.settings.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.settings.chatModel || 'gpt-4o-mini',
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: FORMAT_PROMPT },
            { role: 'user', content: raw },
          ],
        }),
        throw: false,
      })
      if (res.status >= 400) throw new Error(res.json?.error?.message ?? `HTTP ${res.status}`)
      const out = JSON.parse(res.json.choices[0].message.content)
      const strip = (t: unknown) => String(t ?? '').replace(/```/g, "'''")
      return { transcript: strip(out.transcript) || raw, summary: strip(out.summary) }
    } catch (err: any) {
      // Never lose the transcript because the summary step failed
      new Notice(`Mnemo: summary failed (${err?.message ?? 'error'}) — raw transcript kept.`, 8000)
      return { transcript: raw, summary: '' }
    }
  }

  private insert(block: string, audioLink: string) {
    const text = audioLink ? `${audioLink}\n${block}` : block

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
    this.statusEl?.setText(`🔴${live} ${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}`)
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
  private value = ''

  ask(): Promise<string | null> {
    return new Promise(resolve => {
      this.resolve = resolve
      this.open()
    })
  }

  onOpen() {
    this.titleEl.setText('Label this recording')
    new Setting(this.contentEl).setName('Label').addText(t => {
      t.setPlaceholder('e.g. Lecture — Thermodynamics week 3').onChange(v => (this.value = v))
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
      .setName('AI formatting & summary')
      .setDesc('Tidies the transcript, writes maths/science as LaTeX, and fills the Summary tab.')
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
