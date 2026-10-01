# Mnemo — Voice Transcriber for Obsidian

Record your voice (or a lesson, lecture, meeting) inside Obsidian and get a clean transcript **and** an AI summary dropped straight into your note — like Notion's AI transcription, but in your own vault.

- **One-click recording** from the ribbon, command palette or a hotkey
- **Live mode** — text appears in your note while you speak
- **Tabbed result block** — *Transcript* and *Summary* tabs with a copy button
- **Maths & science notation** — spoken formulas become LaTeX (e.g. "x squared plus two x" → $x^2 + 2x$)
- **Mixed languages** — handles speakers who switch languages mid-sentence (e.g. English ↔ isiZulu) without translating
- **Saves & labels audio** — recordings are stored in your vault with a name you choose

Uses your own OpenAI API key. Nothing goes through a third-party server — audio is sent directly from Obsidian to OpenAI.

---

## Requirements

- [Obsidian](https://obsidian.md) 1.4 or newer (desktop; mobile should also work)
- An [OpenAI API key](https://platform.openai.com/api-keys) with billing enabled
- To build from source: [Node.js](https://nodejs.org) 18+ and [git](https://git-scm.com)

---

## Installation

Mnemo isn't in the Obsidian Community Plugins store, so you install it manually. Pick **one** option.

### Option A — Download a release (no coding)

1. Go to the [Releases page](https://github.com/sekophungula/mnemo-obsidian/releases) and download `main.js`, `manifest.json` and `styles.css` from the latest release.
2. Continue at [Copy the plugin into your vault](#copy-the-plugin-into-your-vault).

### Option B — Build from source

```bash
git clone https://github.com/sekophungula/mnemo-obsidian.git
cd mnemo-obsidian
npm install
npm run build
```

This creates `main.js` in the project folder. You'll copy it together with `manifest.json` and `styles.css`.

### Copy the plugin into your vault

1. Find your vault folder (in Obsidian: **Settings → About → Vault location**, or right-click the vault name → *Reveal in Finder/Explorer*).
2. Inside it, open the hidden `.obsidian` folder → `plugins`. Create a folder called **`mnemo`**.
   - macOS: press <kbd>⌘</kbd> <kbd>⇧</kbd> <kbd>.</kbd> in Finder to show hidden folders.
   - Windows: *View → Show → Hidden items* in File Explorer.
3. Put `main.js`, `manifest.json` and `styles.css` into that folder:

   ```
   <your vault>/.obsidian/plugins/mnemo/
   ├── main.js
   ├── manifest.json
   └── styles.css
   ```

   From the terminal (after building):

   ```bash
   mkdir -p "/path/to/your/vault/.obsidian/plugins/mnemo"
   ```

   ```bash
   cp main.js manifest.json styles.css "/path/to/your/vault/.obsidian/plugins/mnemo/"
   ```

### Enable it

1. In Obsidian open **Settings → Community plugins**.
2. If **Restricted mode** is on, turn it off.
3. Click the refresh icon next to *Installed plugins*, then toggle **Mnemo Voice Transcriber** on.
4. Open **Settings → Mnemo Voice Transcriber** and paste your OpenAI API key.

The first time you record, your OS will ask for microphone permission for Obsidian — allow it.

---

## Usage

1. Put your cursor in a note where the transcript should go.
2. Click the **microphone icon** in the left ribbon. It pulses red and a timer appears in the status bar.
3. Click it again to stop. Enter a label for the recording (e.g. *Physics — Newton's laws*).
4. A block appears with the audio player above it and **Transcript / Summary** tabs.

### Commands (<kbd>⌘/Ctrl</kbd> + <kbd>P</kbd>)

| Command | What it does |
| --- | --- |
| **Mnemo: Start / stop voice transcription** | Records, then transcribes when you stop (uses live mode if *Live mode by default* is on) |
| **Mnemo: Start / stop live transcription** | Text appears every few seconds while you speak |

Assign hotkeys under **Settings → Hotkeys** (search "Mnemo"). If you use the *Editing Toolbar* plugin you can add these commands as toolbar buttons.

### Normal vs live mode

- **Normal** transcribes the whole recording at once — most accurate. Limited to 25 MB per recording (roughly 2+ hours).
- **Live** transcribes in short chunks — you see text as you go, no length limit, and each chunk detects its language separately (best for lessons that switch languages). Words can occasionally split at chunk boundaries.

### The result block

Mnemo stores everything as plain text in your note, so it's searchable and future-proof:

````markdown
![[x/Recordings/2026-10-01 1530 Physics — Newton's laws.webm]]
```mnemo
--- transcript
Today we look at Newton's second law, $F = ma$ …
--- summary
## Newton's second law
- $F = ma$ …
```
````

Obsidian renders it as a tabbed box. Switch to Source mode to edit the text directly.

---

## Settings

| Setting | Default | Notes |
| --- | --- | --- |
| OpenAI API key | — | Required. Stored locally in `.obsidian/plugins/mnemo/data.json`. |
| Language | *(blank)* | ISO code like `en` or `zu`. Blank = auto-detect (recommended for mixed-language speech). |
| Transcription model | `gpt-4o-transcribe` | Best for mixed languages. `gpt-4o-mini-transcribe` is cheaper; `whisper-1` also available. |
| AI formatting & summary | On | Cleans the transcript, converts maths/science to LaTeX, writes the summary. |
| Summary model | `gpt-4o-mini` | Any OpenAI chat model. Use a stronger one for heavy maths. |
| Live mode by default | Off | Makes the ribbon button use live mode. |
| Live chunk length | 10 s | 3–30 s. Shorter = faster text, slightly less accurate. |
| Save audio to vault | On | Keeps the recording and embeds it above the transcript. |
| Ask for a label | On | Files are named `YYYY-MM-DD HHmm <label>`. |
| Audio folder | `x/Recordings` | Any folder in your vault; created automatically. |

---

## Costs

You pay OpenAI directly for what you use. Roughly: transcription costs a fraction of a US cent per minute of audio, and the summary step is usually under a cent per recording with `gpt-4o-mini`. Check [OpenAI pricing](https://openai.com/api/pricing) for current rates.

## Privacy & security

- Audio is sent only to `api.openai.com`, directly from your device.
- Your API key lives in your vault's `.obsidian/plugins/mnemo/data.json`. **Don't commit or publicly sync that file** — if your vault is in a public git repo, add it to `.gitignore`.

## Troubleshooting

| Problem | Fix |
| --- | --- |
| No mic icon in the ribbon | Make sure the plugin is enabled; right-click the ribbon to check it isn't hidden. |
| "Microphone access denied" | macOS: *System Settings → Privacy & Security → Microphone* → enable Obsidian. Windows: *Settings → Privacy → Microphone*. |
| "Invalid OpenAI API key" | Re-paste the key; make sure billing is set up on your OpenAI account. |
| Settings look out of date after updating | Run *Reload app without saving* from the command palette or restart Obsidian. |
| Summary tab empty | The summary step failed (wrong model name or quota) — the raw transcript is kept. Check the model name in settings. |
| Wrong language / translated text | Leave *Language* blank, use `gpt-4o-transcribe`, and try live mode. |

## Development

```bash
npm install
npm run dev     # rebuilds main.js on every change
```

Symlink or copy the project folder into `<vault>/.obsidian/plugins/mnemo` and reload Obsidian to test. Source is in [`src/main.ts`](src/main.ts).

## License

MIT
