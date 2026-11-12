// The text typing out in the band above the prompt: its row, and how many
// of its characters show.
export type BlipTyping = { id: string; shown: number } | null

// A voice the community site lists, with a fingerprint of its sound.
export type BlipCommunityVoice = { name: string; author: string; description: string; version: string }

declare module 'claude-code' {
  interface PluginState {
    blip: {
      typing: BlipTyping
      // Whether a row's text has finished typing out, so the row draws it.
      done: StateFamily<boolean>
      // The community's voices, once fetched.
      catalog: BlipCommunityVoice[]
    }
  }
}
