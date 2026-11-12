// The text typing out in the band above the prompt: its row, and how many
// of its characters show.
export type BlipTyping = { id: string; shown: number } | null

declare module 'claude-code' {
  interface PluginState {
    blip: {
      typing: BlipTyping
      // Whether a row's text has finished typing out, so the row draws it.
      done: StateFamily<boolean>
    }
  }
}
