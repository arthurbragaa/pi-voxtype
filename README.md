# pi-voxtype

`pi-voxtype` connects [voxtype](https://voxtype.io) to pi so spoken input is submitted to the active pi session as normal user messages.

## What it does

- start/stop recording from inside pi
- send transcripts into pi with `pi.sendUserMessage()`
- show a minimal footer icon while active
- isolate transcripts per pi session by default
- queue spoken input as `followUp` or `steer` while pi is busy
- always save private, text-only dictation history for vocabulary review
- show durable `🎙 Dictation` markers and `/tree` labels without modifying model input

## Requirements

- Linux
- pi
- Voxtype **1.0 or newer**, installed and running
- `state_file = "auto"` (or a readable explicit state-file path)
- CLI and daemon versions must match; restart the daemon after upgrading

Batch backends work with normal file output. For **Parakeet Unified streaming**,
stock Voxtype 1.0.1 ignores `record start --file=...` and sends live keyboard
output instead. Stock **1.1.0** now streams safely into a final file, but its
streaming path does **not publish the documented `.done` completion record**.
An isolated real-daemon test reproduced this: the transcript exists after stop,
but consumers waiting for completion time out.

The local **1.1.0+pi.1 compatibility build** adds the missing `ok`/`empty`/`error`
completion record and capability marker. Unlike the older workaround, it keeps
upstream's **native streaming**: transcription runs while speaking, the complete
transcript is written atomically after stop, and Pi receives one message.
Desktop dictation stays streaming. The source patch is in
`compat/voxtype-1.1.0-streaming-file-completion.patch` and applies to tag `v1.1.0`.

The older `compat/voxtype-1.0.1-streaming-file-output.patch` is retained for
1.0.1 users; it buffers file recordings through the same loaded Unified model.

This extension checks `config schema --json` for the compatibility build's
`capabilities.streaming_file_output` marker before starting a streaming engine.
It refuses an unsupported build rather than leaking dictated text or waiting
indefinitely. The marker describes the CLI build, so the daemon version must
match too. A version number alone is not proof of the completion contract.

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

These explicit timings retain the known-working model frame alignment.
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
Pi requests `--no-auto-submit --no-smart-auto-submit --no-osd` per recording,
so a spoken "submit" cannot press Enter or get stripped and Pi's own voice
indicator replaces Voxtype's overlay without editing desktop preferences.

## Commands

- `/voice status`
- `/voice toggle`
- `/voice cancel` — cancel this session's recording/transcription without submission
- `/voice on`
- `/voice off` — disable delivery and cancel this session's active recording
- `/voice steer`
- `/voice followup`
- `/voice doctor`
- `/voice history [1-50]` — review the newest dictations across Pi sessions (default: 10)

Default busy behavior: `followUp`.

## Always-on dictation history

Every completed dictation handled by this extension is archived automatically;
there is **no opt-in or logging switch**. History is separate from the ephemeral
inbox, so starting another take does not erase it. It lives in UTC daily JSONL files:

```text
${XDG_STATE_HOME:-~/.local/state}/pi-voxtype/transcriptions/YYYY-MM-DD.jsonl
```

`/voice history` shows recent text, timestamps, outcome/handoff status, short IDs,
and the directory path. `/voice history 25` reviews more. Previews are capped at
1,000 characters each; the archive preserves full text. Review reads at most the
last 1 MiB of each daily file rather than loading an unbounded file into Pi.

Each record contains a unique dictation ID, timestamp, Pi session ID/file, working
directory, final Voxtype transcript, text handed to Pi, outcome, queue mode, and
Voxtype version/engine/model plus a configuration snapshot of text settings and
replacements taken at recording start. The transcript is **after Voxtype's text
processing**, not raw pre-replacement ASR text; the extension cannot reconstruct
words already changed or filtered by the daemon. Use these records to spot
mistakes, then add targeted dictionary replacements deliberately.

- `submitted` means handed to Pi while idle; `queued` means handed to its busy
  queue. Neither proves a model processed it: another extension may handle or
  transform input, queues can be cleared, and asynchronous provider requests may
  fail. Synchronous send failures are recorded as `failed` with the transcript.
- Empty/error completions get outcome records without user messages. Cancelled
  recordings and their partial text are **not archived**.
- Typed messages and desktop-wide dictation are not captured. No audio is saved.
- The history directory is `0700`; log files are `0600`. Files are local plaintext,
  not encrypted. Treat them as sensitive prompts and include them in your own
  backup/privacy decisions.
- There is **no automatic expiry**; keep records for periodic review and remove
  older daily files manually when desired. `/voice off` does not delete history.
- Logging failures produce a warning once per session and do not block voice
  delivery. Session markers and the standalone log are saved independently.

In the Pi transcript, a compact **`🎙 Dictation`** custom entry identifies each
take. Expand it using Pi's expansion toggle to see the captured text and full
history ID. The marker is also labelled `🎙 Dictation` in `/tree`. Queued dictation
is marked at capture completion; its user message may appear later. Marker data
persists in the session JSONL and can be found by `customType: "pi-voxtype-dictation"`.
It is UI/session metadata, **not an extra message to the model**, and the dictated
user message has no added prefix. Session exports/shares can include this metadata.

History starts with newly completed takes after this extension is loaded; old
unlabelled session messages are not guessed to be dictation.

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
isolated runtime/state directories and mocked pi/daemon calls; they do not capture
audio or submit messages to a real session. They cover history privacy, provenance,
queueing, failure recovery, and unchanged message delivery.

A genuine Pi SDK/session regression check uses a fake daemon CLI and fake model
stream—no microphone, desktop input, real credentials, or provider requests:

```bash
# If the SDK is installed locally:
npm run test:session
# Or, when Pi is installed globally:
PI_SDK_PATH="$(npm root -g)/@earendil-works/pi-coding-agent/dist/index.js" npm run test:session
```

It checks idle and busy/queued dictation, durable markers/tree labels after
reopening a session, actual marker rendering, and absence of provenance in model
context. All session and history files stay in a disposable temporary directory.

For an end-to-end check, use a public JFK speech WAV (the `jfk.wav` sample in
`ggml-org/whisper.cpp`) and a running PipeWire session:

```bash
python3 test/file-output-smoke.py /path/to/voxtype /path/to/jfk.wav test/daemon-smoke.mjs
```

The harness uses a virtual PipeWire microphone. It verifies repeated file
delivery, cancellation, silence, duration limits, file errors, streaming text
replacements, and preserved desktop streaming with mocked keyboard drivers.
The real-extension bridge test mocks the Pi host/UI, not the transcription or
history implementation. It also verifies one private history record and one
session marker, with no cancelled-text logging. Test history stays isolated;
no test audio/messages reach user applications or change the default microphone.
Stock 1.1.0 is expected to fail the completion-sidecar regression test.
