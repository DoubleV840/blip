import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { AudioClip, On, TurnStepChunk } from 'claude-code'

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
function engine(on: On, stored: Record<string, unknown> = {}) {
  const played: { clip: AudioClip; gain?: number }[] = []
  const store = new Map(Object.entries(stored))
  const clock = mock.clock(on)
  const wav = tone()

  on('fs.read', () => ({ value: { base64: wav } }))
  on('store.get', (_, e) => ({ value: store.get(e.key) }))
  on('store.set', (_, e) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('command.register', () => ({ value: { command: 'blip' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('process.run', () => ({
    value: { exitCode: 0, stdout: 'Darwin\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
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

  return { played, store, clock }
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
  expect((await blip($, 'voice kazoo')).text).toContain('`critter`')
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
  expect(played[0]?.clip).toEqual({ asset: expect.stringMatching(/^sounds\/classic\/0_\d+\.wav$/) })
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
