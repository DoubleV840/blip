import { memberOf } from 'claude-code'
import type { EngineInterface, Register, Timer, TurnStepChunk } from 'claude-code'

import { PITCH_STEPS, VOICES } from './voices'
import type { Voice } from './voices'

type Speed = 'slow' | 'normal' | 'fast'

type Settings = {
  enabled: boolean
  typewriter: boolean
  speed: Speed
  voice: string
  volume: number
  pitch: number
  thinking: boolean
  custom?: string
}

// A clip of the plugin's own (`asset`, under its folder), the person's file,
// or a community voice's one sample, pitched by Blip (`voice`).
type Clip = { asset: string } | { path: string } | { voice: string }

// A voice shared on the community site, as its catalog lists it; `version`
// is a fingerprint of its sound, new when a name is taken by a new voice.
type CommunityVoice = { name: string; author: string; description: string; version: string }

// One blip of a phrase: when it starts (ms), its clip, and a small random
// detune (semitones) so no two sound quite alike.
type Blip = { at: number; clip: Clip; detune: number }

// A text typed out in the band above the prompt, then handed to its row:
// a reply's block, or a /blip output drawn as a dialogue box. `times[i]` is
// when its character i appears, in ms from the start.
type Reveal = {
  id: string
  kind: 'reply' | 'box'
  text: string
  isFirstOfReply: boolean
  times: number[]
  shown: number
  startedAt?: number
  isPreparing: boolean
  stop: AbortController
}

// How clips are played: the engine's own player (afplay on macOS), a command
// found on Linux, or PowerShell's on Windows, where the engine has none.
type Player =
  | { kind: 'engine' }
  | { kind: 'command'; argv: (path: string, gain: number) => string[] }
  | { kind: 'windows' }

const STORE_KEY = 'settings'
const CUSTOM = 'custom'
const VOICE_MENU = 'blip-voices'
const CATALOG = { plugin: 'blip', key: 'catalog' } as const
// The community voices: listed and served by the blip-voices repository,
// shown on its site; a voice is one short sample, as base64 text.
const SITE_URL = 'https://blip.ivwi.fr'
const SHARE_URL = 'https://github.com/DoubleV840/blip-voices/issues/new?template=submit-voice.yml'
const REPORT_URL = 'https://github.com/DoubleV840/blip-voices/issues/new?template=report-voice.yml'
const RAW_URL = 'https://raw.githubusercontent.com/DoubleV840/blip-voices/main'
// The same files through GitHub's API: a minute old at most where the raw
// ones can be five, but sixty reads an hour per address.
const API_URL = 'https://api.github.com/repos/DoubleV840/blip-voices/contents'
const API_CATALOG_URL = `${API_URL}/catalog.json`
const VOICE_NAME = /^[a-z0-9][a-z0-9-]{1,19}$/
const MAX_VOICE_SECONDS = 1
const TYPING = { plugin: 'blip', key: 'typing' } as const
const DONE = { plugin: 'blip', key: 'done' } as const
const DEFAULTS: Settings = {
  enabled: true,
  typewriter: true,
  speed: 'normal',
  voice: 'soft',
  volume: 50,
  pitch: 0,
  thinking: false,
}

// The typewriter works the way game text boxes do. Claude's reply is held
// while it is written, then typed out in the band above the prompt, one
// letter per frame (the band redraws thirty times a second), and handed to
// its row in the transcript once whole. Commas and sentence ends pause; a
// long reply types faster, so none takes longer than its speed's ceiling.
const FRAME_MS = 33
const SPEEDS: Record<
  Speed,
  { lettersPerSecond: number; maxSeconds: number; shortPauseMs: number; longPauseMs: number }
> = {
  slow: { lettersPerSecond: 20, maxSeconds: 25, shortPauseMs: 160, longPauseMs: 400 },
  normal: { lettersPerSecond: 30, maxSeconds: 15, shortPauseMs: 120, longPauseMs: 300 },
  fast: { lettersPerSecond: 60, maxSeconds: 6, shortPauseMs: 60, longPauseMs: 150 },
}
// Markdown marks show at once, with the letter after them.
const MARKUP = /[*_`#~]/
// How long a held reply waits to be claimed by its row on screen.
const CLAIM_MS = 10_000

// The blips of a whole text are mixed into one clip, each cut where the next
// starts (one voice, never a pile-up), none closer than BLIP_GAP_MS: past
// about twenty letters a second a game voices every other letter, or it buzzes.
const RATE = 22050
const BLIP_GAP_MS = 45
const DETUNE = 0.35
// afplay takes about this long to start, PowerShell this long on Windows:
// the text waits for its sound.
const AUDIO_LEAD_MS = 60
const WINDOWS_LEAD_MS = 400

// Plays the WAV read as base64 from standard input. Windows' own player reads
// WAV alone and has no volume: Blip mixes the volume into the sound.
const WINDOWS_PLAY = [
  '$bytes = [Convert]::FromBase64String([Console]::In.ReadToEnd())',
  '$file = Join-Path $env:TEMP ("blip-" + [guid]::NewGuid() + ".wav")',
  '[IO.File]::WriteAllBytes($file, $bytes)',
  'try { (New-Object System.Media.SoundPlayer $file).PlaySync() } finally { Remove-Item $file -ErrorAction SilentlyContinue }',
].join('; ')

// Without the typewriter, a streamed piece blips over the time it stays the
// newest text (MAX_WINDOW_MS at most), clip by clip.
const MIN_GAP_MS = 33
const MAX_WINDOW_MS = 200

const THINKING_DROP = -5
const THINKING_GAIN = 0.35
const QUESTION_LIFT = 3

const SPEAKABLE = /[\p{L}\p{N}]/u
const MIME: Record<string, string> = {
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  aif: 'audio/aiff',
  aiff: 'audio/aiff',
  m4a: 'audio/mp4',
  caf: 'audio/x-caf',
  ogg: 'audio/ogg',
}

const DEMO = 'Hello there! I am Blip, and I talk like a game. Shall we write some code together?'

const HELP = [
  'RPG-style text sounds for Claude Code',
  '',
  '- `/blip`: show the current settings',
  '- `/blip on · off`: turn the sounds on or off',
  '- `/blip voice`: pick a voice from a menu, ↑↓ to listen',
  `- \`/blip voice <name>\`: switch directly: ${VOICES.map(v => v.name).join(', ')}, or a community voice`,
  '- `/blip voices`: list every voice, the community\'s too',
  '- `/blip share`: share your own voice with the community',
  '- `/blip report [name]`: report a community voice that shouldn\'t be there',
  '- `/blip speed <slow|normal|fast>`: how fast the text types out',
  '- `/blip typewriter on|off`: type replies out letter by letter, or show them as Claude writes',
  '- `/blip volume <0-100>`: how loud',
  '- `/blip pitch <-12..12>`: shift the voice up or down, in semitones',
  '- `/blip thinking on|off`: also blip, softly, while Claude thinks',
  '- `/blip custom <file>`: your own sound (.wav, .mp3, .aiff); custom off to stop',
  '- `/blip test`: play a short demo',
  '- `/blip reset`: back to the defaults',
  '- `/blip help`: this list',
  '',
  'Sending a message shows the rest of a reply at once, like skipping a dialogue.',
].join('\n')

// Module state: rebuilt by session.start on every load and reload.
let settings: Settings = { ...DEFAULTS }
let player: Player = { kind: 'engine' }
let lastPieceAt = 0
let nextBlipAt = 0
const samplesCache = new Map<string, { samples: Float32Array; rate: number }>()
const pitchedCache = new Map<string, string>()
// Community voices downloaded this session, as base64 WAV.
const downloaded = new Map<string, string>()
let isCatalogOffline = false
let customBytes: { path: string; base64: string; mime: string } | undefined
// Texts released to be typed out, waiting for their row to be drawn; the
// texts typing out, oldest first; the frame timer while any is.
let held: { key: string; kind: Reveal['kind']; at: number }[] = []
let reveals: Reveal[] = []
let ticker: Timer | undefined
let isTicking = false

const clamp = (n: number, low: number, high: number) => Math.min(high, Math.max(low, n))

const voiceNamed = (name: string): Voice | undefined => VOICES.find(v => v.name === name)

const gainOf = (isQuiet: boolean) => (settings.volume / 50) * (isQuiet ? THINKING_GAIN : 1)

const signed = (n: number) => `${n > 0 ? '+' : ''}${n}`

function normalize(raw: unknown): Settings {
  const stored = typeof raw === 'object' && raw !== null ? (raw as Partial<Settings>) : {}
  const s = { ...DEFAULTS, ...stored }
  // A community voice is checked against the store once the session starts.
  const isKnownVoice = s.voice === CUSTOM ? Boolean(s.custom) : VOICE_NAME.test(String(s.voice))

  return {
    enabled: s.enabled !== false,
    typewriter: s.typewriter !== false,
    speed: s.speed in SPEEDS ? s.speed : DEFAULTS.speed,
    voice: isKnownVoice ? s.voice : DEFAULTS.voice,
    volume: clamp(Math.round(Number(s.volume)) || 0, 0, 100),
    pitch: clamp(Math.round(Number(s.pitch)) || 0, -12, 12),
    thinking: s.thinking === true,
    ...(s.custom ? { custom: s.custom } : {}),
  }
}

async function save($: EngineInterface) {
  await $.store.set(STORE_KEY, settings)
}

async function findPlayer($: EngineInterface): Promise<Player> {
  try {
    if ((await $.env.get('OS')) === 'Windows_NT') return { kind: 'windows' }

    const os = await $.process.run(['uname', '-s'], { timeoutMs: 3000 })
    if (os.stdout.trim() !== 'Linux') return { kind: 'engine' }

    const found = await $.process.run(
      ['sh', '-c', 'command -v pw-play || command -v paplay || command -v aplay'],
      { timeoutMs: 3000 },
    )
    const bin = found.stdout.trim().split('\n')[0] ?? ''

    if (bin.endsWith('pw-play')) {
      return { kind: 'command', argv: (path, gain) => [bin, `--volume=${gain.toFixed(2)}`, path] }
    }
    if (bin.endsWith('paplay')) {
      return {
        kind: 'command',
        argv: (path, gain) => [bin, `--volume=${Math.round(clamp(gain, 0, 1) * 65536)}`, path],
      }
    }
    if (bin.endsWith('aplay')) return { kind: 'command', argv: path => [bin, '-q', path] }
  } catch {
    // No uname (Windows): the engine's player is all there is.
  }

  return { kind: 'engine' }
}

// ---- Sound -----------------------------------------------------------------

const pathOf = ($: EngineInterface, clip: Clip) =>
  'asset' in clip ? `${$.plugin.root}/${clip.asset}` : 'path' in clip ? clip.path : ''

// Whether blips of this clip can be mixed into one track: any but a custom
// sound that is no WAV.
const isMixable = (clip: Clip) => !('path' in clip) || clip.path.toLowerCase().endsWith('.wav')

function bytesOf(base64: string): Uint8Array {
  const text = atob(base64)
  const bytes = new Uint8Array(text.length)
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i)
  return bytes
}

function base64Of(bytes: Uint8Array): string {
  let text = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    text += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(text)
}

// The samples of a clip: a community voice from those loaded, a file from
// disk, decoded once.
async function samplesOf($: EngineInterface, clip: Clip) {
  if ('voice' in clip) {
    const loaded = samplesCache.get(`voice:${clip.voice}`)
    if (loaded === undefined) throw new Error(`voice ${clip.voice} is not loaded`)
    return loaded
  }

  const path = pathOf($, clip)
  const cached = samplesCache.get(path)
  if (cached !== undefined) return cached

  const { base64 } = await $.fs.read(path, { as: 'bytes' })
  const decoded = decodeWav(bytesOf(base64), path)
  samplesCache.set(path, decoded)
  return decoded
}

// The samples of a 16-bit PCM WAV file, its channels mixed down.
function decodeWav(bytes: Uint8Array, label: string) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let channels = 1
  let rate = RATE
  let bits = 16
  let offset = 12

  while (offset + 8 <= bytes.length) {
    const id = String.fromCharCode(...bytes.subarray(offset, offset + 4))
    const size = view.getUint32(offset + 4, true)
    if (id === 'fmt ') {
      channels = view.getUint16(offset + 10, true)
      rate = view.getUint32(offset + 12, true)
      bits = view.getUint16(offset + 22, true)
    } else if (id === 'data') {
      if (bits !== 16) throw new Error(`${label}: ${bits}-bit audio, 16-bit expected`)
      const frames = Math.floor(Math.min(size, bytes.length - offset - 8) / (2 * channels))
      const samples = new Float32Array(frames)
      for (let f = 0; f < frames; f++) {
        let sum = 0
        for (let c = 0; c < channels; c++) sum += view.getInt16(offset + 8 + (f * channels + c) * 2, true)
        samples[f] = sum / channels / 32768
      }
      return { samples, rate }
    }
    offset += 8 + size + (size % 2)
  }

  throw new Error(`${label}: no audio data`)
}

// Resamples to RATE, `semitones` higher or lower.
function pitched({ samples, rate }: { samples: Float32Array; rate: number }, semitones: number) {
  const step = (rate / RATE) * 2 ** (semitones / 12)
  const out = new Float32Array(Math.max(1, Math.floor((samples.length - 1) / step)))
  for (let j = 0; j < out.length; j++) {
    const at = j * step
    const i = Math.floor(at)
    out[j] = (samples[i] ?? 0) + ((samples[i + 1] ?? 0) - (samples[i] ?? 0)) * (at - i)
  }
  return out
}

function wavOf(samples: Float32Array): string {
  const bytes = new Uint8Array(44 + samples.length * 2)
  const view = new DataView(bytes.buffer)
  const tag = (at: number, text: string) => [...text].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)))
  tag(0, 'RIFF')
  view.setUint32(4, 36 + samples.length * 2, true)
  tag(8, 'WAVE')
  tag(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, RATE, true)
  view.setUint32(28, RATE * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  tag(36, 'data')
  view.setUint32(40, samples.length * 2, true)
  samples.forEach((s, i) => view.setInt16(44 + i * 2, Math.round(clamp(s, -1, 1) * 32767), true))
  return base64Of(bytes)
}

// Mixes blips into one track: each starts on its time, slightly detuned, and
// is cut with a short fade where the next one starts.
// `level` scales it, for a player with no volume of its own.
async function trackOf($: EngineInterface, blips: readonly Blip[], durationMs: number, level = 1) {
  const length = Math.ceil(((durationMs + 400) * RATE) / 1000)
  const out = new Float32Array(length)
  const startOf = (blip: Blip | undefined) => (blip === undefined ? length : Math.round((blip.at * RATE) / 1000))

  for (let k = 0; k < blips.length; k++) {
    const blip = blips[k]!
    const { samples, rate } = await samplesOf($, blip.clip)
    const start = startOf(blip)
    const end = Math.min(length, startOf(blips[k + 1]))
    const step = (rate / RATE) * 2 ** (blip.detune / 12)
    const fade = Math.min(96, end - start)

    for (let j = 0; start + j < end; j++) {
      const at = j * step
      const i = Math.floor(at)
      if (i + 1 >= samples.length) break
      const s = samples[i]! + (samples[i + 1]! - samples[i]!) * (at - i)
      const left = end - start - j
      out[start + j] = (left < fade ? (s * left) / fade : s) * level
    }
  }

  return wavOf(out)
}

// The level a track is mixed at: the volume, where the player has none.
const mixLevel = (gain: number) => (player.kind === 'windows' ? gain : 1)

async function playTrack($: EngineInterface, wav: string, gain: number, signal?: AbortSignal) {
  if (gain <= 0) return

  if (player.kind === 'windows') {
    const argv = ['powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', WINDOWS_PLAY]
    await $.process.run(argv, { stdin: wav, timeoutMs: 60_000 })
    return
  }

  if (player.kind === 'command') {
    const play = player.argv('', gain).slice(0, -1)
    const script = 'f=$(mktemp); base64 -d > "$f"; "$@" "$f"; rm -f "$f"'
    await $.process.run(['sh', '-c', script, 'sh', ...play], { stdin: wav, timeoutMs: 60_000 })
    return
  }

  await $.audio.play({ base64: wav, mime: 'audio/wav' }, signal ? { gain, signal } : { gain })
}

async function playClip($: EngineInterface, clip: Clip, gain: number, semitones = 0) {
  if (gain <= 0) return

  // On Windows a clip is a track of its own: pitched and levelled here.
  if (player.kind === 'windows') {
    if (!isMixable(clip)) return
    await playTrack($, wavOf(pitched(await samplesOf($, clip), semitones).map(s => s * gain)), gain)
    return
  }

  if ('voice' in clip) {
    const key = `${clip.voice}:${semitones}`
    let wav = pitchedCache.get(key)
    if (wav === undefined) {
      wav = wavOf(pitched(await samplesOf($, clip), semitones))
      pitchedCache.set(key, wav)
    }
    await playTrack($, wav, gain)
    return
  }

  if (player.kind === 'command') {
    await $.process.run(player.argv(pathOf($, clip), gain), { timeoutMs: 5000 })
    return
  }

  if ('asset' in clip) {
    await $.audio.play({ asset: clip.asset }, { gain })
    return
  }

  if (customBytes?.path !== clip.path) {
    const { base64 } = await $.fs.read(clip.path, { as: 'bytes' })
    const extension = clip.path.split('.').pop()?.toLowerCase() ?? ''
    customBytes = { path: clip.path, base64, mime: MIME[extension] ?? 'audio/wav' }
  }
  await $.audio.play({ base64: customBytes.base64, mime: customBytes.mime }, { gain })
}

function playLater($: EngineInterface, clip: Clip, gain: number, delayMs: number, semitones = 0) {
  const play = () => void playClip($, clip, gain, semitones).catch(() => {})
  if (delayMs <= 0) play()
  else $.clock.after(delayMs, play)
}

// The note for one letter. It stays near the voice's own pitch, as a voice
// does: a step or two from the letter, vowels a little higher, plus the
// sentence's shape (`shift`) and the pitch setting. A built-in voice has a
// clip per note; a community voice's one sample is pitched by `semitones`.
function noteFor(letter: string, shift: number, voiceName = settings.voice): { clip: Clip; semitones: number } {
  if (voiceName === CUSTOM && settings.custom) return { clip: { path: settings.custom }, semitones: 0 }

  const builtIn = voiceNamed(voiceName)
  const isCommunity = builtIn === undefined && samplesCache.has(`voice:${voiceName}`)
  const voice = builtIn ?? voiceNamed(DEFAULTS.voice) ?? VOICES[0]!
  const spread = isCommunity ? 4 : voice.spread
  const lower = letter.toLowerCase()
  const code = lower.codePointAt(0) ?? 0
  const vowel = 'aeiou'.indexOf(lower.normalize('NFD')[0] ?? '')
  const move = Math.round((((code % 5) - 2) * spread) / 5) + (vowel >= 0 ? 1 : 0)

  if (isCommunity) {
    return { clip: { voice: voiceName }, semitones: clamp(settings.pitch + move + shift, -12, 12) }
  }

  const variant = voice.isVowels && vowel >= 0 ? vowel : code % voice.variants
  const step = clamp(Math.floor(PITCH_STEPS / 2) + settings.pitch + move + shift, 0, PITCH_STEPS - 1)
  return { clip: { asset: `sounds/${voice.name}/${variant}_${step}.wav` }, semitones: 0 }
}

// ---- Timing ----------------------------------------------------------------

// When each character of `text` appears, in ms, with the end last.
function timelineOf(text: string, isCapped = true): number[] {
  const pace = SPEEDS[settings.speed]
  const letterMs = 1000 / pace.lettersPerSecond
  const times: number[] = []
  let t = 0

  for (let i = 0; i < text.length; i++) {
    times.push(t)
    const char = text[i]!
    const after = text[i + 1] ?? ' '
    if (MARKUP.test(char) || (char >= '\uD800' && char <= '\uDBFF')) continue
    t += letterMs
    if (/[.!?]/.test(char) && /\s/.test(after)) t += pace.longPauseMs
    else if (/[,;:]/.test(char) && /\s/.test(after)) t += pace.shortPauseMs
    else if (char === '\n') t += pace.shortPauseMs
  }
  times.push(t)

  const scale = isCapped ? Math.min(1, (pace.maxSeconds * 1000) / Math.max(t, 1)) : 1
  return scale < 1 ? times.map(x => x * scale) : times
}

// How many characters show `elapsed` ms in, never half a surrogate pair.
function shownAt(text: string, times: readonly number[], elapsed: number): number {
  let low = 0
  let high = text.length
  while (low < high) {
    const mid = (low + high + 1) >> 1
    if ((times[mid - 1] ?? 0) <= elapsed) low = mid
    else high = mid - 1
  }
  const last = text.charCodeAt(low - 1)
  return last >= 0xd800 && last <= 0xdbff ? low + 1 : Math.max(1, low)
}

// The blips of a text: voiced letters, never closer than BLIP_GAP_MS, the
// last few of a sentence rising for a question and falling for a statement.
function blipsOf(text: string, times: readonly number[], voiceName = settings.voice, shift = 0): Blip[] {
  const endings: string[] = []
  let ending = ''
  for (let i = text.length - 1; i >= 0; i--) {
    if (/[.!?\n]/.test(text[i]!)) ending = text[i]!
    endings[i] = ending
  }

  const blips: Blip[] = []
  let last = -Infinity
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!
    const at = times[i] ?? 0
    if (!SPEAKABLE.test(char) || at - last < BLIP_GAP_MS) continue
    last = at

    const tail = text.slice(i, i + 8)
    const isNearEnd = /[.!?]/.test(tail)
    const contour = !isNearEnd ? 0 : endings[i] === '?' ? QUESTION_LIFT : endings[i] === '.' ? -1 : 0
    const note = noteFor(char, contour + shift, voiceName)
    blips.push({ at, clip: note.clip, detune: note.semitones + (Math.random() * 2 - 1) * DETUNE })
  }

  return blips
}

// Plays a phrase as one mixed track; a custom sound that is no WAV plays clip
// by clip instead.
async function say($: EngineInterface, phrase: string, voiceName = settings.voice, signal?: AbortSignal) {
  const times = timelineOf(phrase, false)
  const blips = blipsOf(phrase, times, voiceName)
  const canMix = blips.every(b => isMixable(b.clip))

  if (!canMix) {
    blips.forEach(b => playLater($, b.clip, gainOf(false), b.at, Math.round(b.detune)))
    return
  }
  const gain = gainOf(false)
  await playTrack($, await trackOf($, blips, times.at(-1) ?? 0, mixLevel(gain)), gain, signal)
}

function speak($: EngineInterface, phrase: string, voiceName = settings.voice) {
  void say($, phrase, voiceName).catch(() => {})
}

// Voices a streamed piece letter by letter over the time it stays the newest
// text (the gap since the previous piece): the typewriter's off.
function voicePiece($: EngineInterface, text: string, isQuiet: boolean) {
  if (!settings.enabled) return

  const letters = [...text].filter(c => SPEAKABLE.test(c))
  if (letters.length === 0) return

  const now = Date.now()
  const window = clamp(now - lastPieceAt, MIN_GAP_MS, MAX_WINDOW_MS)
  let free = nextBlipAt - now

  const blips: Blip[] = []
  letters.forEach((letter, i) => {
    const at = (i * window) / letters.length
    if (at < free) return
    free = at + MIN_GAP_MS
    const note = noteFor(letter, isQuiet ? THINKING_DROP : 0)
    blips.push({ at, clip: note.clip, detune: note.semitones })
  })
  lastPieceAt = now
  nextBlipAt = now + free

  // Windows starts a player per sound, too slowly for a clip per letter: the
  // piece's blips go as one track.
  const gain = gainOf(isQuiet)
  if (player.kind === 'windows' && blips.every(b => isMixable(b.clip))) {
    void trackOf($, blips, window, gain)
      .then(wav => playTrack($, wav, gain))
      .catch(() => {})
    return
  }
  blips.forEach(b => playLater($, b.clip, gain, b.at, b.detune))
}

// ---- The typewriter --------------------------------------------------------

// The first words of a text, spaces folded: how a released text and the row
// drawing it find each other.
const keyOf = (text: string) => text.replace(/^blip: /, '').replace(/\s+/g, ' ').trim().slice(0, 60)

// A text to type out once its row is drawn.
function release($: EngineInterface, text: string, kind: Reveal['kind']) {
  const key = keyOf(text)
  if (key === '') return

  const now = Date.now()
  held = [...held.filter(h => now - h.at < CLAIM_MS), { key, kind, at: now }]
  ticker ??= $.clock.every(FRAME_MS, () => void tick($).catch(() => {}))
}

// A row drawn for the first time: typed out when its text was released.
function claim(id: string, text: string, kind: Reveal['kind'], isFirstOfReply: boolean) {
  const index = held.findIndex(h => h.kind === kind && h.key === keyOf(text))
  if (index < 0) return undefined
  held.splice(index, 1)

  const shown = text.replace(/^blip: /, '')
  const reveal: Reveal = {
    id,
    kind,
    text: shown,
    isFirstOfReply,
    times: timelineOf(shown),
    shown: 0,
    isPreparing: false,
    stop: new AbortController(),
  }
  reveals.push(reveal)

  return reveal
}

// Mixes the text's track, then starts it and the text together.
async function begin($: EngineInterface, reveal: Reveal) {
  const blips = blipsOf(reveal.text, reveal.times)
  const canMix = blips.every(b => isMixable(b.clip))
  const level = mixLevel(gainOf(false))
  const track = canMix ? await trackOf($, blips, reveal.times.at(-1) ?? 0, level).catch(() => undefined) : undefined
  const lead = settings.volume === 0 ? 0 : player.kind === 'engine' ? AUDIO_LEAD_MS : player.kind === 'windows' ? WINDOWS_LEAD_MS : 0

  if (track !== undefined) {
    void playTrack($, track, gainOf(false), reveal.stop.signal).catch(() => {})
  } else {
    blips.forEach(b => playLater($, b.clip, gainOf(false), b.at + lead, Math.round(b.detune)))
  }
  reveal.startedAt = (await $.clock.now()) + lead
}

// One frame: the oldest text types its next letters; the others wait their
// turn, as text boxes do. Done, it goes to its row. Idle, the timer stops.
async function tick($: EngineInterface) {
  if (isTicking) return
  isTicking = true

  try {
    const reveal = reveals[0]
    if (reveal === undefined) {
      const now = Date.now()
      held = held.filter(h => now - h.at < CLAIM_MS)
      if (held.length === 0) {
        ticker?.cancel()
        ticker = undefined
      }
      return
    }

    if (reveal.startedAt === undefined) {
      if (!reveal.isPreparing) {
        reveal.isPreparing = true
        await begin($, reveal)
      }
      return
    }

    const shown = shownAt(reveal.text, reveal.times, (await $.clock.now()) - reveal.startedAt)
    if (shown >= reveal.text.length) {
      reveals = reveals.filter(r => r !== reveal)
      await $.state.set({ ...DONE, id: reveal.id }, true)
      await $.state.set(TYPING, null)
    } else if (shown !== reveal.shown) {
      reveal.shown = shown
      await $.state.set(TYPING, { id: reveal.id, shown })
    }
  } finally {
    isTicking = false
  }
}

// Shows every text in full at once: a new message skips the rest.
function finishAll($: EngineInterface) {
  for (const reveal of reveals) {
    reveal.stop.abort()
    void $.state.set({ ...DONE, id: reveal.id }, true).catch(() => {})
  }
  reveals = []
  held = []
  void $.state.set(TYPING, null).catch(() => {})
}

// The part of a typed text that fits the band: its last rows, starting on a
// whole line, with a code fence reopened if the cut fell inside one, and an
// open inline mark closed so the half-typed text draws as it will end up.
function visibleOf(text: string, columns: number, rows: number): string {
  const lines = text.split('\n')
  const height = (line: string) => Math.max(1, Math.ceil(line.length / Math.max(10, columns)))
  let used = 0
  let first = lines.length
  while (first > 0 && used + height(lines[first - 1]!) <= rows) used += height(lines[--first]!)

  const dropped = lines.slice(0, first).join('\n')
  const isInFence = ((dropped.match(/^```/gm) ?? []).length & 1) === 1
  let shown = (isInFence ? '```\n' : '') + lines.slice(first).join('\n')

  if (((shown.match(/^```/gm) ?? []).length & 1) === 1) return `${shown}\n\`\`\``
  if (((shown.replace(/```/g, '').match(/`/g) ?? []).length & 1) === 1) shown += '`'
  if (((shown.match(/\*\*/g) ?? []).length & 1) === 1) shown += '**'
  return shown
}

// ---- Community voices ------------------------------------------------------

// The voices the community site lists. Fetched afresh with `fresh` (through
// the API, so a voice published a minute ago shows), else once a session;
// the last list stands in when the network fails.
async function catalogOf($: EngineInterface, fresh = false): Promise<CommunityVoice[]> {
  const known = await $.state.get(CATALOG)
  if (known.value && !isCatalogOffline && !fresh) return known.value

  let response
  try {
    const raw = () => $.http.fetch(`${RAW_URL}/catalog.json`)
    response = fresh
      ? await $.http.fetch(API_CATALOG_URL, { headers: { Accept: 'application/vnd.github.raw' } })
      : await raw()
    if (!response.ok && fresh) response = await raw()
    if (!response.ok) throw new Error(`the community catalog answered ${response.status}`)
  } catch (error) {
    if (known.value && !isCatalogOffline) return known.value
    throw error
  }
  isCatalogOffline = false

  const catalog = JSON.parse(response.text) as { voices?: unknown[]; removed?: unknown[] }
  const voices = (catalog.voices ?? []).flatMap(raw => {
    const v = raw as Partial<CommunityVoice> & { official?: boolean }
    const isValid = !v.official && typeof v.name === 'string' && VOICE_NAME.test(v.name) && !voiceNamed(v.name)
    if (!isValid) return []
    return [{ name: v.name!, author: String(v.author ?? ''), description: String(v.description ?? ''), version: String(v.version ?? '') }]
  })
  await $.state.set(CATALOG, voices)
  await forgetRemoved($, (catalog.removed ?? []).filter((n): n is string => typeof n === 'string' && VOICE_NAME.test(n)))
  await renewChanged($, voices)

  return voices
}

// A voice the maintainers removed from the community is deleted here too;
// in use, the default voice takes its place.
async function forgetRemoved($: EngineInterface, names: readonly string[]) {
  for (const name of names) {
    if ((await $.store.get(`voice:${name}`)) === undefined && !samplesCache.has(`voice:${name}`)) continue
    await forget($, name)

    if (settings.voice === name) {
      settings.voice = DEFAULTS.voice
      await save($)
      $.ui.toast(`Blip: the voice ${name} was removed from the community, back to ${DEFAULTS.voice}.`)
    }
  }
}

// An installed voice whose sound changed (its name taken again by a new
// voice) is dropped, and downloaded afresh if in use.
async function renewChanged($: EngineInterface, voices: readonly CommunityVoice[]) {
  const installed = await installedVoices($)
  for (const voice of voices) {
    if (!installed.has(voice.name)) continue
    const stored = (await $.store.get(`voice:${voice.name}`)) as { version?: string } | undefined
    if ((stored?.version ?? '') === voice.version) continue
    await forget($, voice.name)
    if (settings.voice === voice.name && !(await loadVoice($, voice.name, true).catch(() => false))) {
      settings.voice = DEFAULTS.voice
      await save($)
    }
  }
}

async function forget($: EngineInterface, name: string) {
  await $.store.delete(`voice:${name}`)
  samplesCache.delete(`voice:${name}`)
  downloaded.delete(name)
  for (const key of pitchedCache.keys()) if (key.startsWith(`${name}:`)) pitchedCache.delete(key)
}

// Loads a community voice into memory: from the store when it was installed
// before, else downloaded (and, with `install`, stored for later sessions).
async function loadVoice($: EngineInterface, name: string, install = false): Promise<boolean> {
  if (samplesCache.has(`voice:${name}`)) {
    if (install && (await $.store.get(`voice:${name}`)) === undefined) await storeVoice($, name)
    return true
  }

  const stored = (await $.store.get(`voice:${name}`)) as { base64?: string } | undefined
  let base64 = stored?.base64
  if (base64 === undefined) {
    // Through the API first, as fresh as the catalog that named it.
    const path = `voices/${name}/voice.txt`
    let response = await $.http
      .fetch(`${API_URL}/${path}`, { headers: { Accept: 'application/vnd.github.raw' } })
      .catch(() => undefined)
    if (!response?.ok) response = await $.http.fetch(`${RAW_URL}/${path}`)
    if (!response.ok) return false
    base64 = response.text.trim()
  }

  const decoded = decodeWav(bytesOf(base64), name)
  if (decoded.samples.length / decoded.rate > MAX_VOICE_SECONDS) throw new Error(`${name} is too long`)
  samplesCache.set(`voice:${name}`, decoded)
  downloaded.set(name, base64)
  if (install && stored === undefined) await storeVoice($, name)

  return true
}

// Kept with the version the catalog gives it, to notice when it changes.
async function storeVoice($: EngineInterface, name: string) {
  const base64 = downloaded.get(name)
  if (base64 === undefined) return
  const listed = ((await $.state.get(CATALOG)).value ?? []).find(v => v.name === name)
  await $.store.set(`voice:${name}`, { base64, ...(listed?.version ? { version: listed.version } : {}) })
}

// Switches to a voice by name: built in, or from the community (installed).
async function useVoice($: EngineInterface, name: string): Promise<string> {
  const builtIn = voiceNamed(name)
  if (builtIn !== undefined) {
    settings.voice = builtIn.name
    await save($)
    speak($, `Hi! I am ${builtIn.name}.`)
    return `Voice: **${builtIn.name}**, ${builtIn.description}.`
  }

  // A community voice is one the catalog lists (looked up afresh if this
  // session's list lacks it), or one installed before.
  let voices = await catalogOf($).catch(() => [] as CommunityVoice[])
  if (!voices.some(v => v.name === name)) voices = await catalogOf($, true).catch(() => voices)
  const shared = voices.find(v => v.name === name)
  const isStored = VOICE_NAME.test(name) && (await $.store.get(`voice:${name}`)) !== undefined
  if (shared === undefined && !isStored) {
    return `No voice named \`${name}\`. Browse them all on ${SITE_URL}, or type \`/blip voice\` for the menu.`
  }
  if (!(await loadVoice($, name, true).catch(() => false))) {
    return `Couldn't download \`${name}\` from ${SITE_URL}. Try again in a moment.`
  }

  settings.voice = name
  await save($)
  speak($, `Hi! I am ${name}.`)
  return `Voice: **${name}**${shared ? `, ${shared.description}, by ${shared.author}` : ''}. Installed from the community.`
}

// ---- The /blip command -----------------------------------------------------

function status() {
  const voice =
    settings.voice === CUSTOM
      ? `custom (${settings.custom})`
      : voiceNamed(settings.voice) === undefined
        ? `${settings.voice} (community)`
        : settings.voice
  const parts = [
    `typewriter **${settings.typewriter ? settings.speed : 'off'}**`,
    `voice **${voice}**`,
    `volume **${settings.volume}**`,
    `pitch **${signed(settings.pitch)}**`,
    `thinking **${settings.thinking ? 'on' : 'off'}**`,
  ]

  return `Blip is **${settings.enabled ? 'on' : 'off'}** · ${parts.join(' · ')}\n\nType \`/blip help\` for every command.`
}

// The community voices installed on this machine, by name.
async function installedVoices($: EngineInterface): Promise<Set<string>> {
  const keys = await $.store.keys()
  return new Set(keys.filter(key => key.startsWith('voice:')).map(key => key.slice('voice:'.length)))
}

async function voiceList($: EngineInterface) {
  const installed = await installedVoices($)
  const mark = (name: string) =>
    name === settings.voice ? ' **(current)**' : installed.has(name) ? ' **(installed)**' : ''
  const builtIn = VOICES.map(v => `- \`${v.name}\`: ${v.description}${mark(v.name)}`)
  const shared = await catalogOf($, true).catch(() => undefined)
  const community =
    shared === undefined
      ? [
          `Couldn't reach the community voices: see ${SITE_URL}.`,
          ...[...installed].map(name => `- \`${name}\`${mark(name)}`),
        ]
      : shared.length === 0
        ? ['None yet: be the first with `/blip share`.']
        : shared.map(v => `- \`${v.name}\`: ${v.description}, by ${v.author}${mark(v.name)}`)

  return ['Voices', '', ...builtIn, '', 'Community', '', ...community, '', 'Switch with `/blip voice <name>`.'].join('\n')
}

function onOff(value: string): boolean | undefined {
  if (['on', 'yes', 'true', '1'].includes(value)) return true
  if (['off', 'no', 'false', '0'].includes(value)) return false
  return undefined
}

async function chooseVoice($: EngineInterface, name: string) {
  await $.ui.close({ id: VOICE_MENU })
  await useVoice($, name)
  $.ui.toast(`Blip voice: ${settings.voice}`)
}

async function openVoiceMenu($: EngineInterface): Promise<string> {
  const opened = await $.ui.open({
    id: VOICE_MENU,
    title: 'Blip voices',
    focus: true,
    closeOnEscape: true,
    holdToasts: true,
    rows: VOICES.length + 12,
  })
  if (!opened.isPlaced) return voiceList($)

  // The community's voices join the menu once fetched, afresh each time.
  void catalogOf($, true).catch(async () => {
    isCatalogOffline = true
    await $.state.set(CATALOG, [])
  })
  return 'Pick a voice in the menu: ↑↓ to listen, Enter to choose, Esc to close.'
}

async function setCustom($: EngineInterface, value: string): Promise<string> {
  if (value === '' || value === 'off') {
    if (settings.voice === CUSTOM) settings.voice = DEFAULTS.voice
    await save($)
    return `Custom sound off: back to **${settings.voice}**.`
  }

  const home = (await $.env.get('HOME')) ?? ''
  const wanted = value.replace(/^["']|["']$/g, '').replace(/^~(?=\/|$)/, home)
  const found = await $.fs.stat(wanted, { resolve: true }).catch(() => undefined)
  if (found?.kind !== 'file' || found.realPath === undefined) {
    return `No file at \`${wanted}\`.`
  }

  settings = { ...settings, voice: CUSTOM, custom: found.realPath }
  await save($)
  speak($, 'Hi!')

  return `Custom sound: \`${found.realPath}\`. Pitch and voice tunes don't apply to it.`
}

async function run($: EngineInterface, args: string): Promise<string> {
  const [word = '', ...rest] = args.trim().split(/\s+/).filter(Boolean)
  const option = word.toLowerCase()
  const value = rest.join(' ').trim()
  const lower = value.toLowerCase()

  switch (option) {
    case '':
    case 'status':
      return status()

    case 'help':
    case '?':
      return HELP

    case 'on':
    case 'off':
    case 'toggle': {
      settings.enabled = option === 'toggle' ? !settings.enabled : option === 'on'
      if (!settings.enabled) finishAll($)
      await save($)
      if (settings.enabled) speak($, 'Blip!')
      return `Blip is **${settings.enabled ? 'on' : 'off'}**.`
    }

    case 'voice':
      return lower === '' ? openVoiceMenu($) : useVoice($, lower)

    case 'voices':
      return lower === '' ? voiceList($) : useVoice($, lower)

    case 'share':
      return [
        'Share your own voice with everyone:',
        '',
        '1. Make one short sound, under half a second, that is yours (or CC0).',
        `2. Drop it on ${SITE_URL}/#share, whatever its format (.mp3, .wav, .m4a, .ogg, .flac…): you hear it as Blip will.`,
        '3. Give it a name and a theme, and share it. No account needed.',
        ...(settings.voice === CUSTOM && settings.custom ? ['', `Your custom sound is \`${settings.custom}\`.`] : []),
        '',
        `It is checked automatically and goes live in about a minute on ${SITE_URL} and in everyone's \`/blip voice\` menu.`,
        `Rather use GitHub? The form: ${SHARE_URL}`,
      ].join('\n')

    case 'report': {
      const name = lower || settings.voice
      if (voiceNamed(name) !== undefined || name === CUSTOM || !VOICE_NAME.test(name)) {
        return 'Only community voices can be reported: `/blip report <name>`.'
      }
      const url = `${REPORT_URL}&title=${encodeURIComponent(`Report: ${name}`)}&voice=${encodeURIComponent(name)}`
      return `Report \`${name}\` here: ${url}\n\nThree reports from different people remove a voice, everywhere.`
    }

    case 'speed': {
      if (lower === '') return `Text speed: **${settings.speed}** (slow, normal, fast).`
      if (!(lower in SPEEDS)) return 'Speed takes `slow`, `normal` or `fast`.'
      settings.speed = lower as Speed
      await save($)
      return `Text speed: **${settings.speed}**.`
    }

    case 'typewriter': {
      const isOn = onOff(lower)
      if (isOn === undefined) {
        return `Typewriter: **${settings.typewriter ? 'on' : 'off'}**. Use \`/blip typewriter on\` or \`off\`.`
      }
      settings.typewriter = isOn
      if (!isOn) finishAll($)
      await save($)
      return isOn
        ? 'Typewriter **on**: replies type out letter by letter.'
        : 'Typewriter **off**: replies show as Claude writes them, and blip as they stream.'
    }

    case 'volume': {
      if (lower === '') return `Volume: **${settings.volume}** (0-100).`
      const volume = Number(lower.replace('%', ''))
      if (!Number.isFinite(volume)) return 'Volume takes a number from 0 to 100.'
      settings.volume = clamp(Math.round(volume), 0, 100)
      await save($)
      speak($, 'Like this?')
      return `Volume: **${settings.volume}**.`
    }

    case 'pitch': {
      if (lower === '') return `Pitch: **${signed(settings.pitch)}** (-12 to +12 semitones).`
      const pitch = Number(lower)
      if (!Number.isFinite(pitch)) return 'Pitch takes a number from -12 to 12.'
      settings.pitch = clamp(Math.round(pitch), -12, 12)
      await save($)
      speak($, 'How is this?')
      return `Pitch: **${signed(settings.pitch)}**.`
    }

    case 'thinking': {
      const isOn = onOff(lower)
      if (isOn === undefined) {
        return `Thinking blips: **${settings.thinking ? 'on' : 'off'}**. Use \`/blip thinking on\` or \`off\`.`
      }
      settings.thinking = isOn
      await save($)
      return `Thinking blips: **${isOn ? 'on' : 'off'}**.`
    }

    case 'custom':
      return setCustom($, value)

    case 'test':
    case 'demo':
      if (settings.volume === 0) return 'The volume is at 0: try `/blip volume 50`.'
      // Typed out in the dialogue box, like a reply.
      if (settings.typewriter) release($, DEMO, 'box')
      else speak($, DEMO)
      return DEMO

    case 'reset':
      settings = { ...DEFAULTS }
      await save($)
      return `Back to the defaults.\n\n${status()}`

    default:
      return `Unknown option \`${word}\`. Type \`/blip help\` for the list.`
  }
}

// ---- Completion ------------------------------------------------------------

// What Tab offers after `/blip `: each option, then each option's values.
const OPTIONS: readonly [string, string][] = [
  ['voice', 'pick a voice, or name one'],
  ['voices', 'list every voice'],
  ['speed', 'how fast the text types out'],
  ['volume', 'how loud, 0 to 100'],
  ['pitch', 'higher or lower, -12 to 12'],
  ['on', 'sounds on'],
  ['off', 'sounds off'],
  ['typewriter', 'letter by letter, on or off'],
  ['thinking', 'blip while Claude thinks, on or off'],
  ['custom', 'your own sound file'],
  ['share', 'share your voice with everyone'],
  ['report', 'report a community voice'],
  ['test', 'play a short demo'],
  ['reset', 'back to the defaults'],
  ['help', 'every command'],
]
const ON_OFF: readonly [string, string][] = [
  ['on', ''],
  ['off', ''],
]

async function completions($: EngineInterface, words: readonly string[]): Promise<[string, string][]> {
  if (words.length === 2) return [...OPTIONS]

  const option = words[1]!.toLowerCase()
  if (words.length !== 3) return []
  if (option === 'speed') return Object.keys(SPEEDS).map(speed => [speed, ''])
  if (option === 'typewriter' || option === 'thinking') return [...ON_OFF]
  if (option === 'custom') return [['off', 'back to your voice']]
  if (option !== 'voice' && option !== 'voices' && option !== 'report') return []

  // The community's names come from this session's catalog, fetched in the
  // background the first time so the next keystroke has them.
  const { value: shared } = await $.state.get(CATALOG)
  if (shared === undefined) void catalogOf($).catch(() => {})
  const installed = await installedVoices($)
  const community = new Map((shared ?? []).map(v => [v.name, `${v.description} · ${v.author}`]))
  for (const name of installed) if (!community.has(name)) community.set(name, 'installed')

  const builtIn: [string, string][] = VOICES.map(v => [v.name, v.description])
  return option === 'report' ? [...community] : [...builtIn, ...community]
}

// ---- Hooks -----------------------------------------------------------------

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    settings = normalize(await $.store.get(STORE_KEY))
    player = await findPlayer($)
    // A community voice comes from the store, or the default stands in.
    if (settings.voice !== CUSTOM && voiceNamed(settings.voice) === undefined) {
      const isStored = (await $.store.get(`voice:${settings.voice}`)) !== undefined
      const isLoaded = isStored && (await loadVoice($, settings.voice).catch(() => false))
      if (!isLoaded) settings.voice = DEFAULTS.voice
      // Still listed? A removed voice is dropped, in the background.
      else void catalogOf($).catch(() => {})
    }
    await $.command.register({
      name: 'blip',
      description: 'RPG-style text sounds: /blip help for every option',
      argumentHint: '[on|off|voice|speed|volume|pitch|test|help]',
      immediate: true,
    })

    return next(e)
  })

  on('command.run', { command: 'blip' }, async ($, e) => ({ text: await run($, e.args) })).catch(
    () => ({ text: 'Blip ran into a problem with that option. Try `/blip help`.' }),
  )

  // The reply streams through here piece by piece. With the typewriter, its
  // text is held until the block ends, so its half-written lines never show,
  // and released whole in its place in the stream; without it, each piece
  // blips as it streams. A subagent's text is not shown, so it stays silent.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined) return yield* next(e)

    const isTyping = settings.enabled && settings.typewriter
    let block: TurnStepChunk[] = []
    const text = () => block.map(c => (c.kind === 'text' ? c.text : '')).join('')

    for await (const chunk of next(e)) {
      if (chunk.kind === 'text' && isTyping) {
        block.push(chunk)
        continue
      }
      if (block.length > 0) {
        release($, text(), 'reply')
        yield* block
        block = []
      }
      if (chunk.kind === 'text') voicePiece($, chunk.text, false)
      else if (chunk.kind === 'thinking' && settings.thinking) voicePiece($, chunk.text, true)
      yield chunk
    }

    if (block.length > 0) {
      release($, text(), 'reply')
      yield* block
    }
  })

  // A reply's row stays empty while its text types out in the band.
  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    const reveal =
      reveals.find(r => r.id === e.requestId) ?? claim(e.requestId, e.props.text, 'reply', e.props.isFirstOfReply)
    const { value: isDone } = await $.state.get(memberOf(DONE, e))
    if (reveal === undefined || isDone === true) return next(e)

    const { Box } = $.ui.resolve(e)
    return <Box />
  })

  // The band above the prompt: the text typing out, drawn as its row will be.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const { value: typing } = await $.state.get(TYPING)
    const reveal = typing ? reveals.find(r => r.id === typing.id) : undefined
    if (typing == null || reveal === undefined || e.props.hasSurvey) return next(e)

    const { Box, Text, Markdown } = $.ui.resolve(e)
    const typed = reveal.text.slice(0, typing.shown)

    if (reveal.kind === 'box') {
      return (
        <Box borderStyle="double" borderColor="claude" paddingX={1} flexDirection="column">
          <Text bold color="claude">
            ♪ Blip
          </Text>
          <Markdown text={visibleOf(typed, e.props.bodyColumns - 4, e.props.maxRows - 3)} />
        </Box>
      )
    }

    return (
      <Box flexDirection="row">
        <Box width={2} flexShrink={0}>
          <Text>{reveal.isFirstOfReply ? '⏺' : ' '}</Text>
        </Box>
        <Box flexGrow={1} flexDirection="column">
          <Markdown text={visibleOf(typed, e.props.bodyColumns - 2, e.props.maxRows - 1)} />
        </Box>
      </Box>
    )
  })

  // Tab completes `/blip`'s options and their values: the voices, the speeds…
  on('prompt.autocomplete', async ($, e, next) => {
    const words = e.text.slice(0, e.cursor).trimStart().split(/\s+/)
    if (words[0] !== '/blip' || words.length < 2) return next(e)

    const token = e.token.toLowerCase()
    const own = (await completions($, words))
      .filter(([value]) => value.startsWith(token))
      .map(([value, description]) => (description ? { text: value, description } : { text: value }))
    const { suggestions } = await next(e)
    return { suggestions: [...own, ...suggestions] }
  })

  // A new message skips what is still typing out.
  on('prompt.submit', ($, e, next) => {
    finishAll($)
    return next(e)
  })

  // The command's answers, drawn as an RPG dialogue box with a name tag:
  // a list item `- \`command\`: what it does` becomes an aligned row. The
  // demo's box stays empty while it types out in the band.
  on('ui.render', { component: 'CommandOutput', props: { command: 'blip' } }, async ($, e, next) => {
    if (e.props.isErrored) return next(e)
    const reveal = reveals.find(r => r.id === e.requestId) ?? claim(e.requestId, e.props.text, 'box', false)
    const { value: isDone } = await $.state.get(memberOf(DONE, e))
    const { Box, Text, Markdown } = $.ui.resolve(e)
    if (reveal !== undefined && isDone !== true) return <Box />

    const lines = e.props.text.replace(/^blip: /, '').split('\n')
    const items = lines.map(line => line.match(/^- `([^`]+)`: (.*)$/))
    const column = Math.max(0, ...items.map(item => (item?.[1]?.length ?? 0) + 2))

    return (
      <Box borderStyle="double" borderColor="claude" paddingX={1} flexDirection="column">
        <Text bold color="claude">
          ♪ Blip
        </Text>
        {lines.map((line, i) => {
          const item = items[i]
          if (item === null || item === undefined) {
            return line === '' ? <Text> </Text> : <Markdown text={line} />
          }

          return (
            <Box flexDirection="row">
              <Box width={column} flexShrink={0}>
                <Text color="claude">{item[1]}</Text>
              </Box>
              <Markdown text={item[2] ?? ''} />
            </Box>
          )
        })}
      </Box>
    )
  })

  // The voice menu: the built-in voices, their numbers as hotkeys, then the
  // community's once fetched.
  on('ui.render', { component: 'Pane', requestId: 'blip-voices' }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const { value: shared } = await $.state.get(CATALOG)
    const installed = await installedVoices($)
    const names = [...VOICES.map(v => v.name), ...(shared ?? []).map(v => v.name)]
    const width = Math.max(...names.map(name => name.length)) + 2

    const row = (name: string, description: string, hotkey?: string) => {
      const isCurrent = name === settings.voice

      return (
        <Button
          key={name}
          plain
          {...(hotkey ? { hotkey } : {})}
          {...(isCurrent ? { autoFocus: true as const } : {})}
          onPress={() => void chooseVoice($, name).catch(() => {})}
        >
          {name.padEnd(width)}
          <Text dimColor>{description}</Text>
          {isCurrent ? <Text color="claude"> ●</Text> : ''}
        </Button>
      )
    }

    return (
      <Box flexDirection="column">
        <Text dimColor>↑↓ to listen · Enter to choose · Esc to close</Text>
        {VOICES.map((voice, i) => row(voice.name, voice.description, String(i + 1)))}
        <Text> </Text>
        <Text bold color="claude">
          Community
        </Text>
        {shared === undefined || shared === null ? (
          <Text dimColor>Loading the voices of {SITE_URL}…</Text>
        ) : isCatalogOffline ? (
          <Text dimColor>Couldn't reach {SITE_URL}.</Text>
        ) : shared.length === 0 ? (
          <Text dimColor>None yet: share yours with /blip share.</Text>
        ) : (
          shared.map(voice =>
            row(voice.name, `${voice.description} · ${voice.author}${installed.has(voice.name) ? ' · installed' : ''}`),
          )
        )}
      </Box>
    )
  })

  // Moving through the menu plays the voice under the cursor.
  on('ui.focus', { component: 'Pane', requestId: 'blip-voices' }, async ($, e, next) => {
    const moved = await next(e)
    const name = e.element
    if (moved.deny !== undefined || name === undefined) return moved

    if (voiceNamed(name)) speak($, 'Hello there!', name)
    // A community voice is downloaded to be heard, and kept only if chosen.
    else if (VOICE_NAME.test(name)) {
      void loadVoice($, name)
        .then(isLoaded => isLoaded && speak($, 'Hello there!', name))
        .catch(() => {})
    }

    return moved
  })
}
