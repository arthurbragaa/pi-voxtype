#!/usr/bin/env python3
"""End-to-end regression: real Unified model, virtual mic, no real typing.

Usage: python3 test/file-output-smoke.py /path/to/voxtype /path/to/jfk.wav [test/daemon-smoke.mjs]
Needs a running PipeWire session and pw-loopback/pw-play/pw-dump. Does not
change the system default microphone or contact a speech API. Test artifacts
are kept under the printed temporary directory; all processes are cleaned up.
"""
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time

binary = str(Path(sys.argv[1]).resolve())
sample = str(Path(sys.argv[2]).resolve())
root = Path(tempfile.mkdtemp(prefix="voxtype-file-smoke-"))
print(f"Artifacts: {root}", flush=True)
runtime = root / "runtime"
runtime.mkdir(mode=0o700)
bindir = root / "bin"
bindir.mkdir()
keyboard_log = root / "keyboard.jsonl"
# No synthetic keyboard event can reach a user application in these tests.
for name in ["eitype", "wtype", "dotool", "dotoolc", "ydotool", "wl-copy", "xclip", "xsel"]:
    path = bindir / name
    path.write_text("#!/usr/bin/python3\nimport json,sys\nwith open(" + repr(str(keyboard_log))
                    + ", 'a') as f: f.write(json.dumps(sys.argv) + '\\n')\n")
    path.chmod(0o755)

suffix = str(os.getpid())
sink = "voxtype_test_sink_" + suffix
source = "voxtype_test_mic_" + suffix
alsa = root / "alsa.conf"
alsa.write_text('''</usr/share/alsa/alsa.conf>
pcm.voxtype_test {
    type pipewire
    server "pipewire-0"
    capture_node "''' + source + '''"
    rate 16000
    channels 1
    format "S16LE"
    hint { show on description "Voxtype isolated test source" }
}
''')
env = dict(os.environ,
           XDG_RUNTIME_DIR=str(runtime),
           XDG_STATE_HOME=str(root / "state"),
           PIPEWIRE_RUNTIME_DIR=os.environ.get("XDG_RUNTIME_DIR", f"/run/user/{os.getuid()}"),
           ALSA_CONFIG_PATH=str(alsa),
           PATH=str(bindir) + ":" + os.environ["PATH"])
config = root / "config.toml"
daemon = None
loopback = None
player = None
logs = []

def cli(*args, check=True, timeout=35):
    result = subprocess.run([binary, "-c", str(config), *args], env=env,
                            capture_output=True, text=True, timeout=timeout)
    if check and result.returncode:
        raise AssertionError(f"{args}: exit={result.returncode}\n{result.stdout}\n{result.stderr}")
    return result

def wait_for(predicate, description, timeout=15):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        if daemon is not None and daemon.poll() is not None:
            raise AssertionError("Test daemon exited unexpectedly")
        time.sleep(0.05)
    raise AssertionError("Timed out: " + description)

def state():
    try:
        return (runtime / "voxtype/state").read_text().strip()
    except FileNotFoundError:
        return "missing"

def wait_state(expected):
    wait_for(lambda: state() == expected, "state=" + expected)

def stop_process(process):
    if process is not None and process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)

def start_daemon(max_duration=30, text_rules=""):
    global daemon
    stop_process(daemon)
    daemon = None
    config.write_text(f'''engine = "parakeet"
state_file = "auto"
[hotkey]
enabled = false
mode = "toggle"
[audio]
device = "voxtype_test"
sample_rate = 16000
max_duration_secs = {max_duration}
[parakeet]
model = "parakeet-unified-en-0.6b"
streaming = true
on_demand_loading = false
streaming_chunk_secs = 0.56
streaming_left_context_secs = 5.6
streaming_right_context_secs = 0.56
[output]
mode = "type"
driver_order = ["eitype"]
fallback_to_clipboard = false
pre_type_delay_ms = 0
[output.notification]
on_recording_start = false
on_recording_stop = false
on_transcription = false
[osd]
enabled = false
[vad]
enabled = true
backend = "energy"
{text_rules}
''')
    path = root / f"daemon-{len(logs)}.log"
    logs.append(path)
    with path.open("w") as log:
        daemon = subprocess.Popen([binary, "-c", str(config), "-v", "daemon"], env=env,
                                  stdout=log, stderr=subprocess.STDOUT)
    wait_for(lambda: "Model loaded, ready for voice input" in path.read_text(), "model ready", 25)
    wait_state("idle")

def start_player():
    global player
    player = subprocess.Popen(["pw-play", "--target", sink, sample],
                              stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    return player

def begin_file(name):
    target = root / name
    cli("record", "start", "--no-auto-submit", "--no-smart-auto-submit", "--no-osd", "--file=" + str(target))
    wait_for(lambda: state() in {"recording", "streaming"}, "file recording active")
    # Wait for audio device routing before playback starts.
    time.sleep(0.25)
    return target

def outcome(target):
    return json.loads(Path(str(target) + ".done").read_text())

def assert_no_keyboard():
    assert not keyboard_log.exists() or keyboard_log.stat().st_size == 0, keyboard_log.read_text()

try:
    with (root / "loopback.log").open("w") as log:
        loopback = subprocess.Popen([
            "pw-loopback", "-c", "1", "-m", "MONO",
            "--capture-props", f'media.class=Audio/Sink node.name={sink} node.autoconnect=false priority.session=0',
            "--playback-props", f'media.class=Audio/Source node.name={source} node.autoconnect=false priority.session=0',
        ], stdout=log, stderr=subprocess.STDOUT)
    def nodes_ready():
        nodes = json.loads(subprocess.check_output(["pw-dump"], text=True))
        names = {n.get("info", {}).get("props", {}).get("node.name") for n in nodes}
        return sink in names and source in names
    wait_for(nodes_ready, "virtual microphone nodes")
    start_daemon()
    schema = json.loads(cli("config", "schema", "--json").stdout)
    assert schema["daemon_version"] == schema["voxtype_version"]

    # Repeated takes use the same loaded Unified model and final-file output.
    # Stock 1.1.0 streams to file but misses the documented .done sidecar;
    # this suite deliberately requires it, including for empty/error outcomes.
    for name in ["first.txt", "second.txt"]:
        target = begin_file(name)
        p = start_player()
        p.wait(timeout=20)
        assert p.returncode == 0, p.stderr.read().decode()
        time.sleep(0.3)
        assert not Path(str(target) + ".done").exists(), "No premature completion"
        assert not target.exists() or not target.read_text(), "No partial transcript file"
        stopped_at = time.monotonic()
        cli("record", "stop")
        wait_for(lambda: Path(str(target) + ".done").exists(), "completed transcript", 25)
        delivery_secs = time.monotonic() - stopped_at
        wait_state("idle")
        assert outcome(target)["status"] == "ok"
        text = target.read_text().strip()
        assert "ask not what your country can do for you" in text.lower(), text
        assert "ask what you can do for your country" in text.lower(), text
        assert_no_keyboard()
        print(f"PASS {name} ({delivery_secs:.2f}s after stop): {text}", flush=True)
    assert logs[0].read_text().count("Parakeet streaming model loaded in") == 1

    if len(sys.argv) > 3:
        # Exercise the actual extension too; only its pi message sink is mocked.
        subprocess.run(["node", sys.argv[3], binary, str(config), sink, sample],
                       env=env, check=True, timeout=45)
        assert_no_keyboard()

    target = begin_file("cancelled.txt")
    p = start_player()
    time.sleep(2)
    cli("record", "cancel")
    wait_state("idle")
    stop_process(p)
    time.sleep(0.2)
    assert not Path(str(target) + ".done").exists()
    assert not target.exists() or not target.read_text()
    assert_no_keyboard()
    print("PASS cancellation: no transcript, no output", flush=True)

    target = begin_file("empty.txt")
    time.sleep(0.4)
    cli("record", "stop")
    wait_for(lambda: Path(str(target) + ".done").exists(), "empty completion", 15)
    wait_state("idle")
    assert outcome(target)["status"] == "empty"
    assert_no_keyboard()
    print("PASS silence: empty completion, no output", flush=True)

    # A duration limit must keep --file rather than fall back to desktop typing.
    start_daemon(max_duration=4)
    target = begin_file("timeout.txt")
    p = start_player()
    wait_for(lambda: Path(str(target) + ".done").exists(), "timeout completion", 15)
    wait_state("idle")
    stop_process(p)
    assert outcome(target)["status"] == "ok"
    assert target.read_text().strip()
    assert_no_keyboard()
    print("PASS duration limit: transcript still delivered only to file", flush=True)

    # A failed transcript write must publish error, not strand the consumer.
    start_daemon()
    (root / "unwritable.txt").mkdir()
    target = begin_file("unwritable.txt")
    p = start_player()
    p.wait(timeout=20)
    cli("record", "stop")
    wait_for(lambda: Path(str(target) + ".done").exists(), "file error completion", 15)
    wait_state("idle")
    assert outcome(target)["status"] == "error", outcome(target)
    assert_no_keyboard()
    print("PASS file error: error completion, no output", flush=True)

    # 1.1.0 applies text replacements to the final streaming file, not only typing.
    start_daemon(text_rules='[text]\nreplacements = { "Americans" = "Pi users" }\n')
    target = begin_file("text-rules.txt")
    p = start_player()
    p.wait(timeout=20)
    cli("record", "stop")
    wait_for(lambda: Path(str(target) + ".done").exists(), "text rule completion", 15)
    wait_state("idle")
    assert outcome(target)["status"] == "ok"
    assert "Pi users" in target.read_text(), target.read_text()
    assert_no_keyboard()
    print("PASS text rules: streaming file receives vocabulary replacement", flush=True)

    # Ordinary desktop recording remains streaming (captured by the mock driver).
    start_daemon()
    cli("record", "start")
    wait_state("streaming")
    p = start_player()
    wait_for(lambda: keyboard_log.exists() and keyboard_log.stat().st_size > 0,
             "streaming text before stop", 10)
    assert state() == "streaming"
    stop_process(p)
    cli("record", "stop")
    wait_state("idle")
    print("PASS desktop streaming: live output preserved (mock keyboard only)", flush=True)
    print("ALL END-TO-END TESTS PASSED", flush=True)
finally:
    stop_process(player)
    stop_process(daemon)
    stop_process(loopback)
