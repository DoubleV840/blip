import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { AudioClip, On, PromptAutocompleteInput, PromptAutocompleteResult, TurnStepChunk } from 'claude-code'

const STEP = { turnId: 't1', index: 0, model: 'claude', messageCount: 1 } as const
const START = { cwd: '/', surface: 'terminal', isInteractive: true } as const

// Runs `/blip <args>` as the person typing it at the prompt.
const blip = ($: Engine, args: string) =>
  $.command.run({
    command: 'blip',
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 100 },
  })

// A 16-bit mono WAV of a short tone: every voice clip reads as this.
function tone(): string {
  const frames = 400
  const bytes = new Uint8Array(44 + frames * 2)
  const view = new DataView(bytes.buffer)
  const tag = (at: number, text: string) => [...text].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)))
  tag(0, 'RIFF')
  view.setUint32(4, 36 + frames * 2, true)
  tag(8, 'WAVEfmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, 22050, true)
  view.setUint32(28, 44100, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  tag(36, 'data')
  view.setUint32(40, frames * 2, true)
  for (let i = 0; i < frames; i++) view.setInt16(44 + i * 2, Math.round(Math.sin(i / 4) * 8000), true)
  return btoa(String.fromCharCode(...bytes))
}

// Stands for the engine beneath the plugin: a macOS host, a store and a clock
// in memory, voice files, and an audio player that records what it was asked
// to play.
function engine(on: On, stored: Record<string, unknown> = {}, os: 'macOS' | 'Windows' = 'macOS') {
  const played: { clip: AudioClip; gain?: number }[] = []
  const ran: { argv: readonly string[]; stdin?: string }[] = []
  const store = new Map(Object.entries(stored))
  const clock = mock.clock(on)
  const wav = tone()

  on('fs.read', () => ({ value: { base64: wav } }))
  on('store.get', (_, e) => ({ value: store.get(e.key) }))
  on('store.set', (_, e) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...store.keys()] }))
  on('command.register', () => ({ value: { command: 'blip' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('env.get', (_, e) => ({ value: e.name === 'OS' && os === 'Windows' ? 'Windows_NT' : undefined }))
  on('process.run', (_, e) => {
    ran.push({ argv: e.argv, stdin: e.init?.stdin })
    return {
      value: { exitCode: 0, stdout: 'Darwin\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('audio.play', (_, e) => {
    played.push({ clip: e.clip, gain: e.gain })
    return { value: undefined }
  })
  on('turn.step', async function* () {
    const chunks: TurnStepChunk[] = [
      { kind: 'text', index: 0, text: 'Hello' },
      { kind: 'text', index: 0, text: ' world' },
    ]
    for (const chunk of chunks) yield chunk

    return { ...STEP, answer: 'Hello world', toolUses: [], stopReason: 'end_turn', usage: null }
  })

  return { played, ran, store, clock }
}

async function streamed(step: AsyncIterable<TurnStepChunk>) {
  const texts: string[] = []
  for await (const chunk of step) if (chunk.kind === 'text') texts.push(chunk.text)
  return texts.join('')
}

test('help lists every option and every voice', async ($, on) => {
  engine(on)
  await $.session.start(START)

  const { text } = await blip($, 'help')
  for (const option of ['on', 'voice', 'speed', 'typewriter', 'volume', 'pitch', 'thinking', 'custom', 'test', 'reset']) {
    expect(text).toContain(`/blip ${option}`)
  }
  expect(text).toContain('classic, nes, soft, bubble, typewriter, robot, deep, chirp, critter')
})

test('settings are kept in the store and read back', async ($, on) => {
  // `speed: 3` is how an early version stored its blip rate: it is dropped.
  const { store } = engine(on, { settings: { voice: 'robot', volume: 80, speed: 3 } })
  await $.session.start(START)

  expect((await blip($, '')).text).toContain('voice **robot**')

  await blip($, 'volume 30')
  await blip($, 'pitch +4')
  await blip($, 'speed fast')
  expect(store.get('settings')).toEqual({
    enabled: true,
    typewriter: true,
    speed: 'fast',
    voice: 'robot',
    volume: 30,
    pitch: 4,
    thinking: false,
  })
})

test('bad values are refused with a hint', async ($, on) => {
  engine(on)
  await $.session.start(START)

  expect((await blip($, 'volume loud')).text).toContain('0 to 100')
  expect((await blip($, 'voice kazoo')).text).toContain('No voice named `kazoo`')
  expect((await blip($, 'dance')).text).toContain('/blip help')
})

test('the typewriter types a held reply out in the band, to one mixed track', async ($, on) => {
  const { played, clock } = engine(on)
  // Beneath the plugin, the engine's own drawing of any site.
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  await $.session.start(START)

  // Held while it streams, released whole: the transcript gets every piece.
  expect(await streamed($.turn.step(STEP))).toBe('Hello world')
  expect(played).toHaveLength(0)

  // The reply's row stays empty while the band types it out.
  const row = await $.ui.mount({
    plugin: 'blip',
    surface: 'terminal',
    component: 'AssistantMessage',
    requestId: 'r1',
    props: { text: 'Hello world', isFirstOfReply: true },
  })
  expect(await row.find({ type: 'Text', text: 'engine' })).toBeUndefined()

  const band = await $.ui.mount({
    plugin: 'blip',
    surface: 'terminal',
    component: 'AbovePrompt',
    requestId: 'band',
    props: {
      hasSurvey: false,
      isWorking: false,
      maxRows: 20,
      bodyColumns: 80,
      scroll: { offset: 0, bodyRows: 19 },
      view: {},
    },
  })
  const typed = async () => (await band.find({ type: 'Markdown' }))?.text

  // Normal speed: a letter every 33 ms, once the track is mixed and started.
  await clock.advance(250)
  const early = (await typed()) ?? ''
  expect(early.length).toBeGreaterThan(0)
  expect(early.length).toBeLessThan('Hello world'.length)
  expect('Hello world'.startsWith(early)).toBe(true)

  await clock.advance(1000)
  expect(await typed()).toBeUndefined()
  expect(await row.find({ type: 'Text', text: 'engine' })).toBeDefined()

  // One track for the whole reply, not a clip per letter.
  expect(played).toHaveLength(1)
  expect(played[0]?.clip).toMatchObject({ mime: 'audio/wav' })
  await band.unmount()
  await row.unmount()
})

test('without the typewriter, streamed text blips as it streams', async ($, on) => {
  const { played, clock } = engine(on, { settings: { typewriter: false } })
  await $.session.start(START)

  expect(await streamed($.turn.step(STEP))).toBe('Hello world')
  // The first letter blips at once, the rest of "Hello" over the next 200 ms;
  // " world" came too close behind to fit between them.
  expect(played).toHaveLength(1)
  await clock.advance(200)
  expect(played).toHaveLength(5)
  expect(played[0]?.clip).toEqual({ asset: expect.stringMatching(/^sounds\/soft\/0_\d+\.wav$/) })
})

test('off, and subagents, stay silent', async ($, on) => {
  const { played, clock } = engine(on)
  await $.session.start(START)

  expect(await streamed($.turn.step({ ...STEP, agentId: 'a1' }))).toBe('Hello world')
  await blip($, 'off')
  expect(await streamed($.turn.step(STEP))).toBe('Hello world')
  await clock.advance(1000)
  expect(played).toHaveLength(0)
})

test('the voice menu switches voice on Enter', async ($, on) => {
  const { store } = engine(on)
  await $.session.start(START)

  expect((await blip($, 'voice')).text).toContain('Pick a voice')

  const ui = await $.ui.mount({
    plugin: 'blip',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'blip-voices',
    props: {
      title: 'Blip voices',
      isFocused: true,
      bodyColumns: 60,
      placement: 'inline',
      scroll: { offset: 0, bodyRows: 12 },
      view: {},
    },
  })
  await ui.press({ key: 'critter' })
  expect(store.get('settings')).toMatchObject({ voice: 'critter' })
  await ui.unmount()
})

test('the command output is drawn as a dialogue box with aligned rows', async ($, on) => {
  engine(on)
  await $.session.start(START)
  const { text = '' } = await blip($, 'help')

  const ui = await $.ui.mount({
    plugin: 'blip',
    surface: 'terminal',
    component: 'CommandOutput',
    requestId: 'm1',
    props: { command: 'blip', args: 'help', text: `blip: ${text}`, isErrored: false },
  })
  expect(await ui.find({ type: 'Text', text: '♪ Blip' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '/blip volume <0-100>' })).toBeDefined()
  await ui.unmount()
})

test('a community voice installs by name and is kept for the next session', async ($, on) => {
  const { store, played, clock } = engine(on)
  const catalog = {
    voices: [
      { name: 'classic', author: 'blip', description: 'built in', official: true },
      { name: 'bloop', author: 'someone', description: 'a wet little bloop' },
    ],
  }
  const fetched: string[] = []
  on('http.fetch', (_, e) => {
    fetched.push(e.url)
    const text = e.url.includes('/catalog.json') ? JSON.stringify(catalog) : tone()
    return { value: { status: 200, ok: true, headers: {}, text } }
  })
  await $.session.start(START)

  expect((await blip($, 'voices')).text).toContain('`bloop`: a wet little bloop, by someone')
  expect((await blip($, 'voice bloop')).text).toContain('Installed from the community')
  expect(store.get('settings')).toMatchObject({ voice: 'bloop' })
  expect(store.get('voice:bloop')).toEqual({ base64: tone() })
  expect(fetched.some(url => url.endsWith('/voices/bloop/voice.txt'))).toBe(true)

  // Its sample, pitched by Blip, plays as one track.
  await clock.advance(1000)
  expect(played.at(-1)?.clip).toMatchObject({ mime: 'audio/wav' })

  expect((await blip($, 'voice nope')).text).toContain('No voice named `nope`')
})

test('/blip share points to the submission form', async ($, on) => {
  engine(on)
  await $.session.start(START)

  expect((await blip($, 'share')).text).toContain('issues/new?template=submit-voice.yml')
})

test('a voice removed from the community is deleted, and the default takes its place', async ($, on) => {
  const { store, clock } = engine(on, { settings: { voice: 'bloop' }, 'voice:bloop': { base64: tone() } })
  on('store.delete', (_, e) => {
    store.delete(e.key)
    return { value: undefined }
  })
  on('http.fetch', () => ({
    value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ voices: [], removed: ['bloop'] }) },
  }))
  await $.session.start(START)

  expect((await blip($, 'voices')).text).toContain('None yet')
  await clock.advance(0) // the check the session started in the background
  expect(store.has('voice:bloop')).toBe(false)
  expect(store.get('settings')).toMatchObject({ voice: 'soft' })
})

test('a voice whose name a new voice took is downloaded afresh', async ($, on) => {
  const { store, clock } = engine(on, { settings: { voice: 'bloop' }, 'voice:bloop': { base64: tone(), version: 'old' } })
  on('store.delete', (_, e) => {
    store.delete(e.key)
    return { value: undefined }
  })
  const catalog = { voices: [{ name: 'bloop', author: 'someone else', description: 'a new bloop', version: 'new' }], removed: [] }
  const fetched: string[] = []
  on('http.fetch', (_, e) => {
    fetched.push(e.url)
    const text = e.url.includes('/catalog.json') ? JSON.stringify(catalog) : tone()
    return { value: { status: 200, ok: true, headers: {}, text } }
  })
  await $.session.start(START)
  await clock.advance(0) // the check the session started in the background

  expect(fetched.filter(url => url.endsWith('/voices/bloop/voice.txt'))).toHaveLength(1)
  expect(store.get('voice:bloop')).toEqual({ base64: tone(), version: 'new' })
  expect(store.get('settings')).toMatchObject({ voice: 'bloop' })

  // The same version again: nothing to download.
  await blip($, 'voices')
  expect(fetched.filter(url => url.endsWith('/voices/bloop/voice.txt'))).toHaveLength(1)
})

test('/blip report links the form for a community voice, never a built-in one', async ($, on) => {
  engine(on)
  await $.session.start(START)

  expect((await blip($, 'report bloop')).text).toContain('template=report-voice.yml&title=Report%3A%20bloop&voice=bloop')
  expect((await blip($, 'report classic')).text).toContain('Only community voices')
})

test('/blip voices marks installed voices and reads the catalog afresh', async ($, on) => {
  const { store } = engine(on, { 'voice:bloop': { base64: tone() } })
  const catalog = { voices: [{ name: 'bloop', author: 'someone', description: 'a wet little bloop' }] }
  const urls: string[] = []
  on('http.fetch', (_, e) => {
    urls.push(e.url)
    const text = e.url.includes('/catalog.json') ? JSON.stringify(catalog) : tone()
    return { value: { status: 200, ok: true, headers: {}, text } }
  })
  await $.session.start(START)

  const first = (await blip($, 'voices')).text
  expect(first).toContain('`bloop`: a wet little bloop, by someone **(installed)**')

  // Published since: the next listing has it, read through the API.
  catalog.voices.push({ name: 'zap', author: 'other', description: 'a zap' })
  expect((await blip($, 'voices')).text).toContain('`zap`: a zap, by other')
  expect(urls.filter(url => url.startsWith('https://api.github.com/'))).toHaveLength(2)
  expect(store.has('voice:zap')).toBe(false)
})

test('Tab completes /blip options and their values', async ($, on) => {
  engine(on)
  on('prompt.autocomplete', () => ({ suggestions: [] }))
  await $.session.start(START)
  // The kit raises the event, though its types leave this call out.
  const prompt = $.prompt as unknown as {
    autocomplete: (input: PromptAutocompleteInput) => Promise<PromptAutocompleteResult>
  }
  const offered = async (text: string) => {
    const token = text.split(/\s+/).at(-1) ?? ''
    const { suggestions } = await prompt.autocomplete({ text, cursor: text.length, token, start: text.length - token.length })
    return suggestions.map(s => s.text)
  }

  expect(await offered('/blip vo')).toEqual(['voice', 'voices', 'volume'])
  expect(await offered('/blip voice ty')).toEqual(['typewriter'])
  expect(await offered('/blip speed f')).toEqual(['fast'])
  expect(await offered('/blip thinking o')).toEqual(['on', 'off'])
  expect(await offered('hello wo')).toEqual([])
})

test('on Windows, a reply plays as one track through PowerShell', async ($, on) => {
  const { played, ran, clock } = engine(on, {}, 'Windows')
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  await $.session.start(START)

  expect(await streamed($.turn.step(STEP))).toBe('Hello world')
  const row = await $.ui.mount({
    plugin: 'blip',
    surface: 'terminal',
    component: 'AssistantMessage',
    requestId: 'r1',
    props: { text: 'Hello world', isFirstOfReply: true },
  })
  await clock.advance(2000)

  const tracks = ran.filter(run => run.argv[0] === 'powershell.exe')
  expect(tracks).toHaveLength(1)
  expect(tracks[0]?.stdin?.startsWith('UklGR')).toBe(true) // base64 of "RIFF"
  expect(played).toHaveLength(0)
  await row.unmount()
})
