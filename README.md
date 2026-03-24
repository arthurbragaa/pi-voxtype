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
- `voxtype` installed and working
- `voxtype` daemon running

Recommended voxtype setup that worked well here:

- model: `base.en`
- GPU acceleration enabled
- language: `en`
- `state_file = "auto"`

Useful commands:

```bash
voxtype setup model --set base.en --restart
sudo voxtype setup gpu --enable
voxtype config
voxtype status --format json --extended
```

## Install

### Local path

```bash
pi install /absolute/path/to/pi-voxtype
```

### npm or git

```bash
pi install npm:pi-voxtype
# or
pi install git:github.com/arthurbragaa/pi-voxtype
```

Then inside pi:

```text
/reload
```

## Default usage

- `Alt+Space` once → start recording
- `Alt+Space` again → stop, transcribe, submit

The shortcut auto-enables the bridge for the current session.

## Commands

- `/voice status`
- `/voice toggle`
- `/voice on`
- `/voice off`
- `/voice steer`
- `/voice followup`
- `/voice path <file>`
- `/voice setup`
- `/voice doctor`
- `/voice test [text]`

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

## Compositor binding example

If you prefer compositor-level push-to-talk instead of the in-pi shortcut:

```ini
bind = SUPER, V, exec, sh -lc 'mkdir -p "$XDG_RUNTIME_DIR/pi-voxtype"; : > "$XDG_RUNTIME_DIR/pi-voxtype/inbox.txt"; voxtype record start --file="$XDG_RUNTIME_DIR/pi-voxtype/inbox.txt"'
bindr = SUPER, V, exec, voxtype record stop
```

Then enable the bridge in pi:

```text
/voice on
```

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
