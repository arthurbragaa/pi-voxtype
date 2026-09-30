# pi-voxtype

`pi-voxtype` connects [voxtype](https://voxtype.io) to pi so spoken input is submitted to the active pi session as normal user messages.

## What it does

- start/stop recording from inside pi
- send transcripts into pi with `pi.sendUserMessage()`
- show a minimal footer icon while active
- isolate transcripts per pi session by default
- queue spoken input as `followUp` or `steer` while pi is busy

## Requirements

- Linux
- pi
- Voxtype **1.0 or newer**, installed and running
- `state_file = "auto"` (or a readable explicit state-file path)
- CLI and daemon versions must match; restart the daemon after upgrading

Batch backends work with normal file output. For **Parakeet Unified streaming**,
stock Voxtype 1.0.1 ignores `record start --file=...` and sends live keyboard
output instead. Updating only the extension's state handling does not fix that.

The local **1.0.1+pi.1 compatibility build** fixes this: an explicit file request
uses the **same loaded Unified model** for buffered transcription, then writes
one complete transcript and `.done` record. Desktop dictation remains streaming.
The source patch is in `compat/voxtype-1.0.1-streaming-file-output.patch`.

This extension checks `config schema --json` for the compatibility build's
`capabilities.streaming_file_output` marker before starting a streaming engine.
It refuses an unsupported build rather than leaking dictated text into whatever
application has focus. The marker describes the CLI build, so the daemon version
must match too. Do not replace that check with a guessed future version number.

Tested local model settings:

```toml
engine = "parakeet"
state_file = "auto"

[hotkey]
enabled = false
mode = "toggle"

[parakeet]
model = "parakeet-unified-en-0.6b"
streaming = true
on_demand_loading = false
streaming_chunk_secs = 0.56
streaming_left_context_secs = 5.6
streaming_right_context_secs = 0.56
```

These explicit timings avoid Voxtype 1.0.1's invalid default frame alignment.
GPU acceleration is not required. The configured default microphone is unchanged
by the extension; this machine uses the EPOS headset through PipeWire.

## Install

```bash
pi install npm:pi-voxtype
# or
pi install git:github.com/arthurbragaa/pi-voxtype
```

## Default usage

- `Alt+Space` once → start recording
- `Alt+Space` again → stop, transcribe, submit

The shortcut auto-enables the bridge for the current session. In pi, transcripts
are submitted **once after stop**, not as live partial messages. A 750ms quiet
period suppresses held-key repeats. While transcription is pending, another
shortcut press does not clear the inbox or start a new recording.

After updating this extension, run **`/reload`** in each open pi session.
The desktop Ctrl+Super+X shortcut is separate from pi's Alt+Space shortcut.

## Commands

- `/voice status`
- `/voice toggle`
- `/voice cancel` — cancel this session's recording/transcription without submission
- `/voice on`
- `/voice off` — disable delivery and cancel this session's active recording
- `/voice steer`
- `/voice followup`
- `/voice doctor`

Default busy behavior: `followUp`.

## Environment

- `PI_VOXTYPE_SHORTCUT` — override shortcut
- `PI_VOXTYPE_INBOX` — override inbox path

Examples:

```bash
PI_VOXTYPE_SHORTCUT=f6 pi
PI_VOXTYPE_SHORTCUT=off pi
PI_VOXTYPE_INBOX=/tmp/pi-voxtype-inbox.txt pi
```

## Inbox behavior

Default inbox path:

```text
${XDG_RUNTIME_DIR}/pi-voxtype/<session-hash>.inbox.txt
```

Each pi session gets its own inbox by default, so one recording is not sent to every open pi session.

The extension watches `<inbox>.done`, not incremental transcript writes. It sends
the full transcript once for `ok`, sends nothing for `empty` or `error`, and
suppresses late completions after cancellation. A new recording removes the old
completion record. Identical consecutive dictations are delivered independently.

Do not use a separate `voxtype record stop --wait` consumer on the same inbox:
that command consumes the `.done` record that the extension needs.

Recording/transcription owned by another pi session or by desktop dictation is
not stopped by this session. On reload or exit, the extension cancels its own
active recording and closes its polling timer.

## Troubleshooting

### Shortcut does nothing

Try another key:

```bash
PI_VOXTYPE_SHORTCUT=f6 pi
```

### Recording works but nothing reaches pi

Run:

```text
/voice doctor
/voice status
```

Check:
- `voxtype` is on PATH
- the `voxtype` daemon is running
- the inbox path is writable
- pi and `voxtype` are using the same inbox path

### Status icon never changes

Make sure voxtype has:

```toml
state_file = "auto"
```

`streaming` counts as active recording; unreadable/unknown states do not count
as idle. Run `/voice doctor` to check the daemon and file transport.

### An upgrade makes streaming refuse to start

The compatibility marker may be missing, or the running daemon may still be
an older binary. Run `/voice doctor` and restart the matching daemon. Until an
upstream release supports this file transport, retain the compatibility build
or use a non-streaming model (for example Parakeet TDT v3 with `streaming = false`).

## Tests

```bash
npm test
```

Requires Node 22.18+ for built-in TypeScript stripping. The unit tests use an
isolated runtime directory and mocked pi/daemon calls; they do not capture audio
or submit messages to a real session.

`test/daemon-smoke.mjs` is the real-extension part of the compatibility source's
`tests/pi_file_output_smoke.py` harness. That harness uses a virtual PipeWire
microphone and a public speech WAV. It verifies repeated file delivery,
cancellation, silence, duration limits, and preserved desktop streaming with
mocked keyboard drivers. Only the final pi message sink is mocked in the
real-extension test; no test audio or messages reach user applications.
