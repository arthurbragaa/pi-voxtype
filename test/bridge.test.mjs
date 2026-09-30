import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Never touch the real daemon, microphone, pi session, or user's inbox.
const root = mkdtempSync(join(tmpdir(), "pi-voxtype-test-"));
process.env.XDG_RUNTIME_DIR = join(root, "runtime");
process.env.HOME = join(root, "home");
delete process.env.PI_VOXTYPE_INBOX;
const { default: extension } = await import("../index.ts");
after(() => rmSync(root, { recursive: true, force: true }));

async function harness(t, options = {}) {
	for (const dir of [process.env.XDG_RUNTIME_DIR, process.env.HOME]) {
		rmSync(dir, { recursive: true, force: true });
		mkdirSync(dir, { recursive: true });
	}
	const stateFile = join(process.env.XDG_RUNTIME_DIR, "voxtype/state");
	const ownerFile = join(process.env.XDG_RUNTIME_DIR, "pi-voxtype/active-owner.json");
	mkdirSync(join(process.env.XDG_RUNTIME_DIR, "voxtype"), { recursive: true });
	const setState = (state) => writeFileSync(stateFile, state);
	setState("idle");
	let now = 10_000;
	let timestamp = Date.now() / 1000;
	let busy = false;
	const callbacks = new Map();
	t.mock.method(Date, "now", () => now);
	t.mock.method(globalThis, "setInterval", (callback) => {
		const id = Symbol("poll");
		callbacks.set(id, callback);
		return id;
	});
	t.mock.method(globalThis, "clearInterval", (id) => callbacks.delete(id));
	const commands = [], sent = [], notices = [], events = new Map(), slash = new Map();
	const schema = {
		voxtype_version: "1.0.1+pi.1", daemon_version: "1.0.1+pi.1",
		capabilities: { streaming_file_output: true },
		engine: "parakeet", keys: [{ key: "parakeet.streaming", value: true }],
		...options.schema,
	};
	const ctx = {
		hasUI: true,
		isIdle: () => !busy,
		sessionManager: { getSessionFile: () => "/test/session.jsonl", getBranch: () => [] },
		ui: {
			setStatus() {}, setWidget() {},
			notify: (text, level) => notices.push({ text, level }),
		},
	};
	const api = {
		on: (name, fn) => events.set(name, fn),
		registerShortcut() {},
		registerCommand: (name, spec) => slash.set(name, spec),
		appendEntry() {},
		sendUserMessage: (text, delivery) => sent.push({ text, delivery }),
		exec: async (_program, args) => {
			const command = args[1];
			commands.push(command);
			if (options.exec) {
				const result = await options.exec(command);
				if (result) return result;
			}
			if (command === "voxtype config schema --json") {
				return { code: 0, stdout: JSON.stringify(schema), stderr: "" };
			}
			if (command.startsWith("voxtype record start")) setState("recording");
			if (command === "voxtype record stop") setState("transcribing");
			if (command === "voxtype record cancel") setState("idle");
			return { code: 0, stdout: "", stderr: "" };
		},
	};
	extension(api);
	await events.get("session_start")({ reason: "startup" }, ctx);
	let closed = false;
	const shutdown = async () => {
		if (closed) return;
		closed = true;
		await events.get("session_shutdown")({ reason: "reload" }, ctx);
	};
	t.after(shutdown);
	const voice = async (command, advance = 1000) => {
		now += advance;
		await slash.get("voice").handler(command, ctx);
	};
	const poll = () => { for (const fn of callbacks.values()) fn(); };
	const owner = () => JSON.parse(readFileSync(ownerFile, "utf8"));
	const complete = (text, status = "ok") => {
		const inbox = owner().inboxFile;
		writeFileSync(inbox, text);
		writeFileSync(`${inbox}.done`, JSON.stringify({ status, chars: text.length, message: "test failure" }));
		timestamp += 1;
		utimesSync(`${inbox}.done`, timestamp, timestamp);
		setState("idle");
	};
	return {
		voice, poll, owner, complete, shutdown, setState, stateFile, ownerFile,
		commands, sent, notices, schema, callbacks,
		setBusy: (value) => { busy = value; },
		recordCommands: () => commands.filter((c) => c.startsWith("voxtype record")),
	};
}

test("start -> stop -> completed transcript submits exactly one full message", async (t) => {
	const h = await harness(t);
	await h.voice("toggle");
	assert.match(h.recordCommands()[0], /start --no-auto-submit --file=/);
	writeFileSync(h.owner().inboxFile, "unfinished partial");
	h.poll();
	assert.equal(h.sent.length, 0);
	await h.voice("toggle");
	assert.equal(h.recordCommands()[1], "voxtype record stop");
	h.complete("A complete sentence.\n");
	h.poll(); h.poll();
	assert.deepEqual(h.sent, [{ text: "A complete sentence.", delivery: undefined }]);
});

test("streaming state is active even before the next status poll", async (t) => {
	const h = await harness(t);
	await h.voice("toggle");
	h.setState("streaming");
	await h.voice("toggle");
	assert.equal(h.recordCommands().at(-1), "voxtype record stop");
	assert.equal(h.recordCommands().filter((c) => c.includes(" start")).length, 1);
});

test("unpatched streaming daemon is refused before any recording or inbox write", async (t) => {
	const h = await harness(t, { schema: { capabilities: undefined } });
	await h.voice("toggle");
	assert.equal(h.recordCommands().length, 0);
	assert.match(h.notices.at(-1).text, /bypasses --file/);
});

test("CLI/daemon version mismatch fails closed", async (t) => {
	const h = await harness(t, { schema: { daemon_version: "1.0.1" } });
	await h.voice("toggle");
	assert.equal(h.recordCommands().length, 0);
	assert.match(h.notices.at(-1).text, /versions differ/);
});

test("ordinary batch backends do not require the streaming capability", async (t) => {
	const h = await harness(t, { schema: { capabilities: undefined, keys: [{ key: "parakeet.streaming", value: false }] } });
	await h.voice("toggle");
	assert.equal(h.recordCommands().length, 1);
});

test("toggle while transcribing does not truncate the pending inbox", async (t) => {
	const h = await harness(t);
	await h.voice("toggle");
	const inbox = h.owner().inboxFile;
	writeFileSync(inbox, "keep me");
	h.setState("transcribing");
	await h.voice("toggle");
	assert.equal(readFileSync(inbox, "utf8"), "keep me");
	assert.equal(h.recordCommands().length, 1);
});

test("held-key repeats cannot stop or restart a recording", async (t) => {
	const h = await harness(t);
	await h.voice("toggle");
	await h.voice("toggle", 500);
	await h.voice("toggle", 500);
	assert.equal(h.recordCommands().length, 1);
	await h.voice("toggle", 1000);
	assert.equal(h.recordCommands().at(-1), "voxtype record stop");
});

test("concurrent toggles serialize while the start preflight runs", async (t) => {
	let release;
	const gate = new Promise((resolve) => { release = resolve; });
	const h = await harness(t, { exec: async (c) => { if (c.includes("config schema")) await gate; } });
	const starting = h.voice("toggle");
	await h.voice("toggle");
	release();
	await starting;
	assert.equal(h.recordCommands().length, 1);
});

test("cancel drops a late completion and permits a fresh recording", async (t) => {
	const h = await harness(t);
	await h.voice("toggle");
	const savedOwner = h.owner();
	await h.voice("cancel");
	assert.equal(h.recordCommands().at(-1), "voxtype record cancel");
	writeFileSync(h.ownerFile, JSON.stringify(savedOwner));
	h.complete("Do not submit cancelled audio");
	h.poll();
	assert.equal(h.sent.length, 0);
	await h.voice("toggle");
	h.complete("Fresh recording");
	h.poll();
	assert.deepEqual(h.sent.map((s) => s.text), ["Fresh recording"]);
});

test("off cancels owned capture and suppresses late delivery", async (t) => {
	const h = await harness(t);
	await h.voice("toggle");
	await h.voice("off");
	assert.equal(h.recordCommands().at(-1), "voxtype record cancel");
	assert.equal(readFileSync(h.stateFile, "utf8"), "idle");
});

test("another session's capture is never stopped or cancelled", async (t) => {
	const h = await harness(t);
	await h.voice("toggle");
	const other = { ...h.owner(), inboxFile: "/other/session.txt" };
	writeFileSync(h.ownerFile, JSON.stringify(other));
	await h.voice("toggle");
	await h.voice("cancel");
	assert.equal(h.recordCommands().length, 1);
	assert.equal(h.owner().inboxFile, other.inboxFile);
});

test("missing or unknown state never starts another recording", async (t) => {
	const h = await harness(t);
	h.setState("future-active-state");
	await h.voice("toggle");
	assert.equal(h.recordCommands().length, 0);
	rmSync(h.stateFile);
	await h.voice("toggle");
	assert.equal(h.recordCommands().length, 0);
});

test("busy pi receives one follow-up, not an unsolicited steering message", async (t) => {
	const h = await harness(t);
	h.setBusy(true);
	await h.voice("toggle");
	h.complete("Queue this");
	h.poll();
	assert.deepEqual(h.sent, [{ text: "Queue this", delivery: { deliverAs: "followUp" } }]);
});

test("identical consecutive transcripts are both delivered in full", async (t) => {
	const h = await harness(t);
	for (let i = 0; i < 2; i++) {
		await h.voice("toggle");
		h.complete("Same words");
		h.poll();
	}
	assert.deepEqual(h.sent.map((s) => s.text), ["Same words", "Same words"]);
});

test("a completed take is delivered before the next start clears its inbox", async (t) => {
	const h = await harness(t);
	await h.voice("toggle");
	h.complete("Not polled yet");
	await h.voice("toggle");
	assert.deepEqual(h.sent.map((s) => s.text), ["Not polled yet"]);
});

test("empty and error completions never become user messages", async (t) => {
	const h = await harness(t);
	for (const status of ["empty", "error"]) {
		await h.voice("toggle");
		h.complete("", status);
		h.poll();
	}
	assert.equal(h.sent.length, 0);
	assert.ok(h.notices.some((n) => n.text === "No speech detected"));
	assert.ok(h.notices.some((n) => n.level === "error"));
});

test("reload cancels owned capture and stops polling", async (t) => {
	const h = await harness(t);
	await h.voice("toggle");
	await h.shutdown();
	assert.equal(h.recordCommands().at(-1), "voxtype record cancel");
	assert.equal(h.callbacks.size, 0);
});

test("start command failure clears ownership and reports the error", async (t) => {
	const h = await harness(t, { exec: async (c) => c.includes("record start") ? { code: 1, stdout: "", stderr: "failed to signal" } : undefined });
	await h.voice("toggle");
	assert.equal(readFileSync(h.ownerFile, "utf8"), "");
	assert.match(h.notices.at(-1).text, /failed to signal/);
});
