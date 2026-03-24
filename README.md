# pi-voxtype

`pi-voxtype` connects [voxtype](https://voxtype.io) to pi so voice input lands in the active session as normal user messages.

It stays intentionally small:
- `voxtype` handles audio capture and transcription
- `pi-voxtype` handles inbox watching, shortcut wiring, and message delivery into pi

No private Claude APIs. No browser session scraping.

Naming split:
- package name: `pi-voxtype`
- pi command namespace: `/voice`
- env vars: `PI_VOXTYPE_*`

The command stays generic for ergonomics. Legacy `PI_VOICE_*` env vars are still accepted for backward compatibility.

## Features

- direct `voxtype` → pi bridge
- default shortcut: `Alt+Space` to start/stop recording
- minimal UI: footer icon only in the session that started the current recording/transcription
  - `🎤` recording
  - `⏳` transcribing
- sends transcripts as real user messages via `pi.sendUserMessage()`
- while pi is busy, queues voice as either `followUp` or `steer` (default: `followUp`)
- session-scoped inboxes by default, so multiple pi sessions do not all receive the same transcript
- local Linux workflow with no extra helper scripts required

## Requirements

- pi
- `voxtype` installed and working
- a configured `voxtype` model
- `voxtype` daemon running
  - either start it manually with `voxtype`
  - or install the user service with `voxtype setup systemd`

Recommended checks:

```bash
voxtype config
voxtype status --format json --extended
```

## Install

### Local package path

```bash
pi install /absolute/path/to/pi-voxtype
```

### npm or git

Once published:

```bash
pi install npm:pi-voxtype
# or
pi install git:github.com/arthurbragaa/pi-voxtype
```

Then reload resources inside pi:

```text
/reload
```

## Default workflow

- `Alt+Space` once → start recording
- `Alt+Space` again → stop, transcribe, submit

The shortcut automatically enables the bridge for the current session. `/voice on` is optional when you use the shortcut.

## Commands

- `/voice status` — current runtime state and config
- `/voice toggle` — same start/stop behavior as the shortcut
- `/voice on` — enable bridge for the current session
- `/voice off` — disable bridge for the current session
- `/voice steer` — when pi is busy, deliver spoken input as steering messages
- `/voice followup` — when pi is busy, deliver spoken input as follow-up messages
- `/voice path <file>` — override the transcript inbox path for the current session
- `/voice setup` — print the active shortcut plus raw `voxtype` start/stop commands
- `/voice doctor` — run dependency and environment checks
- `/voice test [text]` — inject a fake transcript for testing

## Shortcut configuration

Default shortcut:

```text
Alt+Space
```

Override it before launching pi:

```bash
PI_VOXTYPE_SHORTCUT=f6 pi
```

Disable extension shortcut registration entirely:

```bash
PI_VOXTYPE_SHORTCUT=off pi
```

This is useful when tmux, the terminal, or the window manager already owns the default key.

## Inbox configuration

Default inbox path:

```text
${XDG_RUNTIME_DIR}/pi-voxtype/<session-hash>.inbox.txt
```

The runtime directory uses `pi-voxtype` so the package name, inbox path, and active-owner state stay in the same namespace.

Each pi session gets its own inbox by default, which prevents one spoken prompt from being delivered to every open pi session.

Override globally before launching pi:

```bash
PI_VOXTYPE_INBOX=/tmp/pi-voxtype-inbox.txt pi
```

Use that only when you intentionally want a shared inbox. Otherwise leave it unset so session isolation stays enabled.

Or change it for the current session only:

```text
/voice path /tmp/pi-voxtype-inbox.txt
```

## Compositor bindings

If you prefer compositor-level push-to-talk instead of the in-pi shortcut, bind `voxtype` directly.

### Hyprland example

```ini
bind = SUPER, V, exec, sh -lc 'mkdir -p "$XDG_RUNTIME_DIR/pi-voxtype"; : > "$XDG_RUNTIME_DIR/pi-voxtype/inbox.txt"; voxtype record start --file="$XDG_RUNTIME_DIR/pi-voxtype/inbox.txt"'
bindr = SUPER, V, exec, voxtype record stop
```

Then, if you are not using the extension shortcut, enable the bridge inside pi:

```text
/voice on
```

## How it works

1. `voxtype` writes transcription output to an inbox file
2. `pi-voxtype` polls that file for new content
3. new transcript text is sent into pi as a real user message
4. if pi is already busy, delivery mode is controlled by `/voice steer` or `/voice followup`

## Troubleshooting

### Shortcut does nothing

Possible causes:
- terminal intercepted the key
- tmux intercepted the key
- window manager intercepted the key

Try:
- `PI_VOXTYPE_SHORTCUT=f6 pi`
- or use compositor bindings instead of the in-pi shortcut

### Recording works but no transcript arrives in pi

Run:

```text
/voice doctor
/voice status
```

Check:
- `voxtype` is on PATH
- the `voxtype` daemon is running
- the inbox path is writable
- `voxtype` and pi are using the same inbox path

### Status icon never changes

Check the voxtype config:

```bash
voxtype config
```

Expected:

```toml
state_file = "auto"
```

If `state_file = "disabled"`, the bridge still works, but the live recording icon cannot track recording/transcribing state.

## Notes

- This package uses your existing pi model/provider auth.
- It targets local Linux workflows where `voxtype` already solves the speech-to-text layer.
- The bridge intentionally stays small and avoids duplicating `voxtype` functionality.
