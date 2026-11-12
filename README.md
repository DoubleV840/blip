<div align="center">

<img src=".claude-plugin/icon.png" width="120" alt="Blip">

# Blip

**Claude Code talks like an RPG character.**<br>
Replies type out letter by letter, with a blip for every letter.

[![Claude Code plugin](https://img.shields.io/badge/Claude%20Code-plugin-D97757?style=flat-square)](#install)
[![macOS | Linux](https://img.shields.io/badge/platform-macOS%20%7C%20Linux-262447?style=flat-square)](#requirements)
[![MIT](https://img.shields.io/badge/license-MIT-262447?style=flat-square)](LICENSE)
[![Ko-fi](https://img.shields.io/badge/Ko--fi-support-FF5E5B?style=flat-square&logo=kofi&logoColor=white)](https://ko-fi.com/blipivwi)

<!-- Demo video with sound goes here -->

</div>

## Install

In Claude Code:

```
/plugin install blip --marketplace DoubleV840/blip
```

Then ask Claude anything, and listen.

## Commands

| Command | |
| --- | --- |
| `/blip voice` | Pick a voice, ↑↓ to listen |
| `/blip speed slow · normal · fast` | Text speed |
| `/blip volume 0-100` | Volume |
| `/blip pitch -12..12` | Higher or lower voice |
| `/blip on · off` | Sound on or off |
| `/blip typewriter on · off` | Letter by letter, or Claude Code's usual display |
| `/blip custom <file.wav>` | Your own sound |
| `/blip test` | Demo |
| `/blip help` | Everything else |

Send a message to skip the rest of a reply, like in a game.

## Voices

`classic` · `nes` · `soft` · `bubble` · `typewriter` · `robot` · `deep` · `chirp` · `critter`

<details>
<summary><b>How it works</b></summary>
<br>

- Claude's reply is held while it is written, then typed out above the prompt at 30 frames a second, and settles into the conversation once whole.
- All the blips of a reply are mixed into one sound before it starts: each on its letter, never overlapping, slightly detuned.
- Commas and sentence ends pause, spaces stay silent, questions rise.
- Commands run locally: no model call, no tokens, no network.
- Voices are synthesized from scratch by [`tools/make_sounds.py`](tools/make_sounds.py).

</details>

<details>
<summary><b>Requirements</b></summary>
<br>

- A recent Claude Code (tested on 2.1.322). Its plugin API is in early access and may change.
- macOS, or Linux with `pw-play`, `paplay` or `aplay`. Windows is not supported yet.
- In the desktop app: **+** → **Plugins** → **Add marketplace** `DoubleV840/blip` → **Add plugin**.

</details>

<details>
<summary><b>Make your own voice</b></summary>
<br>

1. Add a voice to `VOICES` in [`tools/make_sounds.py`](tools/make_sounds.py).
2. Run `python3 tools/make_sounds.py`.
3. Test with `claude plugin test .`, try it with `claude --plugin-dir .`, and open a pull request.

</details>

<div align="center">
<br>

<a href="https://ko-fi.com/blipivwi"><img src="https://ko-fi.com/img/githubbutton_sm.svg" alt="Support Blip on Ko-fi"></a>

<sub>MIT · Not affiliated with Anthropic</sub>

</div>
