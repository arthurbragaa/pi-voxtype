import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadExtension } from "./load-extension.mjs";
import { getHistoryDir, readRecentHistory } from "../history.ts";

// Never touch the real daemon, microphone, pi session, or user's inbox.
const root = mkdtempSync(join(tmpdir(), "pi-voxtype-test-"));
process.env.XDG_RUNTIME_DIR = join(root, "runtime");
process.env.HOME = join(root, "home");
process.env.XDG_STATE_HOME = join(root, "state");
delete process.env.PI_VOXTYPE_INBOX;
const extension = await loadExtension();
after(() => rmSync(root, { recursive: true, force: true }));

async function harness(t, options = {}) {
	for (const dir of [process.env.XDG_RUNTIME_DIR, process.env.HOME, process.env.XDG_STATE_HOME]) {
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
	const commands = [], sent = [], notices = [], entries = [], labels = [], renderers = new Map(), events = new Map(), slash = new Map();
	const schema = {
		voxtype_version: "1.0.1+pi.1", daemon_version: "1.0.1+pi.1",
		capabilities: { streaming_file_output: true },
		engine: "parakeet", replacements: { "vox type": "Voxtype" },
		keys: [
			{ key: "parakeet.streaming", value: true },
			{ key: "parakeet.model", value: "parakeet-unified-en-0.6b" },
			{ key: "text.spoken_punctuation", value: false },
		],
		...options.schema,
	};
	const ctx = {
		hasUI: options.hasUI ?? true,
		cwd: "/test/project",
		isIdle: () => !busy,
		sessionManager: {
			getSessionFile: () => options.sessionFile ?? "/test/session.jsonl",
			getSessionId: () => "test-session-id",
			getLeafId: () => entries.at(-1)?.id ?? null,
			getBranch: () => entries,
		},
		ui: {
			setStatus() {}, setWidget() {},
			notify: (text, level) => notices.push({ text, level }),
		},
	};
	const api = {
		on: (name, fn) => events.set(name, fn),
		registerShortcut() {},
		registerCommand: (name, spec) => slash.set(name, spec),
		registerEntryRenderer: (type, renderer) => renderers.set(type, renderer),
		setLabel: (id, label) => labels.push({ id, label }),
		appendEntry: (customType, data) => {
			if (options.markerError && customType === "pi-voxtype-dictation") throw new Error("Cannot save marker");
			entries.push({ type: "custom", id: String(entries.length), customType, data });
		},
		sendUserMessage: (text, delivery) => {
			if (options.sendError) throw new Error("Send refused");
			sent.push({ text, delivery });
		},
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
		commands, sent, notices, schema, callbacks, entries, labels, renderers,
		history: () => readRecentHistory(50),
		markers: () => entries.filter((entry) => entry.customType === "pi-voxtype-dictation"),
		setBusy: (value) => { busy = value; },
		recordCommands: () => commands.filter((c) => c.startsWith("voxtype record")),
	};
}

test("start -> stop -> completed transcript submits exactly one full message", async (t) => {
	const h = await harness(t);
	await h.voice("toggle");
	assert.match(h.recordCommands()[0], /start --no-auto-submit --no-smart-auto-submit --no-osd --file=/);
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
	assert.match(h.notices.at(-1).text, /verified streaming file completion/);
});

test("stock 1.1.0 stays blocked because streaming omits the completion sidecar", async (t) => {
	const h = await harness(t, { schema: {
		voxtype_version: "1.1.0", daemon_version: "1.1.0", capabilities: undefined,
	} });
	await h.voice("toggle");
	assert.equal(h.recordCommands().length, 0);
	assert.match(h.notices.at(-1).text, /verified streaming file completion/);
});

test("1.1.0 compatibility build advertises the verified completion contract", async (t) => {
	const h = await harness(t, { schema: {
		voxtype_version: "1.1.0+pi.1", daemon_version: "1.1.0+pi.1",
	} });
	await h.voice("toggle");
	h.setState("streaming");
	await h.voice("toggle");
	h.complete("Native streaming transcript");
	h.poll();
	assert.deepEqual(h.sent.map((s) => s.text), ["Native streaming transcript"]);
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

test("always-on history preserves final Voxtype text, metadata, and the unmodified submitted message", async (t) => {
	const h = await harness(t);
	await h.voice("toggle");
	h.complete("  Fix Voxtype please.\n");
	h.poll(); h.poll();
	const [record] = h.history();
	assert.equal(h.history().length, 1);
	assert.equal(record.transcript, "  Fix Voxtype please.\n");
	assert.equal(record.submittedText, "Fix Voxtype please.");
	assert.equal(record.source, "dictation");
	assert.equal(record.scope, "pi");
	assert.equal(record.sessionFile, "/test/session.jsonl");
	assert.equal(record.sessionId, "test-session-id");
	assert.equal(record.cwd, "/test/project");
	assert.equal(record.outcome, "ok");
	assert.equal(record.delivery, "submitted");
	assert.equal(record.voxtype.model, "parakeet-unified-en-0.6b");
	assert.deepEqual(record.voxtype.replacements, { "vox type": "Voxtype" });
	assert.equal(record.voxtype.textSettings["text.spoken_punctuation"], false);
	assert.equal("rawTranscript" in record, false);
	assert.deepEqual(h.sent, [{ text: "Fix Voxtype please.", delivery: undefined }]);
	assert.equal(h.markers().length, 1);
	assert.equal(h.markers()[0].data.id, record.id);
	assert.equal(h.labels.at(-1).label, "🎙 Dictation");
});

test("dictation markers render a compact label and expand without adding labels to model input", async (t) => {
	const h = await harness(t);
	await h.voice("toggle");
	h.complete("A dictated sentence"); h.poll();
	const marker = h.markers()[0];
	const render = h.renderers.get("pi-voxtype-dictation");
	const theme = { fg: (_color, text) => text };
	assert.match(render(marker, { expanded: false }, theme).text, /🎙 Dictation · submitted/);
	assert.doesNotMatch(render(marker, { expanded: false }, theme).text, /A dictated sentence/);
	assert.match(render(marker, { expanded: true }, theme).text, /A dictated sentence/);
	assert.equal(h.sent[0].text, "A dictated sentence");
});

test("queued steering and follow-up dictation get distinct history records without claiming delivery", async (t) => {
	const h = await harness(t);
	h.setBusy(true);
	for (const mode of ["steer", "followup"]) {
		await h.voice(mode);
		await h.voice("toggle");
		h.complete("Same words"); h.poll();
	}
	const history = h.history();
	assert.equal(history.length, 2);
	assert.notEqual(history[0].id, history[1].id);
	assert.deepEqual(history.map((record) => record.busyMode), ["followUp", "steer"]);
	assert.ok(history.every((record) => record.delivery === "queued"));
	assert.equal(h.markers().length, 2);
});

test("empty/error outcomes are recorded without being sent, and cancelled partial audio is not archived", async (t) => {
	const h = await harness(t);
	for (const outcome of ["empty", "error"]) {
		await h.voice("toggle"); h.complete("", outcome); h.poll();
	}
	assert.equal(h.history().length, 2);
	assert.deepEqual(h.history().map((record) => record.outcome), ["error", "empty"]);
	assert.ok(h.history().every((record) => record.delivery === "not-submitted"));
	assert.equal(h.history()[0].error, "test failure");
	await h.voice("toggle");
	writeFileSync(h.owner().inboxFile, "private cancelled partial");
	await h.voice("cancel"); h.poll();
	assert.equal(h.history().length, 2);
	assert.equal(h.sent.length, 0);
});

test("history write failures warn once without breaking dictation or its session markers", async (t) => {
	const h = await harness(t);
	writeFileSync(join(process.env.XDG_STATE_HOME, "pi-voxtype"), "blocked");
	for (let i = 0; i < 2; i++) {
		await h.voice("toggle"); h.complete("Still delivered"); h.poll();
	}
	assert.equal(h.sent.length, 2);
	assert.equal(h.markers().length, 2);
	assert.equal(h.notices.filter((notice) => notice.text.includes("Could not save dictation history")).length, 1);
});

test("session marker failures do not prevent private logging or voice delivery", async (t) => {
	const h = await harness(t, { markerError: true });
	await h.voice("toggle"); h.complete("Still delivered"); h.poll();
	assert.equal(h.sent.length, 1);
	assert.equal(h.history().length, 1);
	assert.ok(h.notices.some((notice) => notice.text.includes("Could not save dictation session marker")));
});

test("synchronous Pi send failures preserve the transcript and failure status", async (t) => {
	const h = await harness(t, { sendError: true });
	await h.voice("toggle"); h.complete("Please keep this failed transcript"); h.poll();
	assert.equal(h.sent.length, 0);
	assert.equal(h.history()[0].delivery, "failed");
	assert.equal(h.history()[0].transcript, "Please keep this failed transcript");
	assert.equal(h.history()[0].submittedText, "");
	assert.equal(h.history()[0].error, "Send refused");
});

test("history is always recorded without an interactive UI", async (t) => {
	const h = await harness(t, { hasUI: false });
	await h.voice("toggle"); h.complete("Headless dictation"); h.poll();
	assert.equal(h.history()[0].submittedText, "Headless dictation");
	assert.equal(h.markers().length, 1);
});

test("/voice history reviews records and validates its bounded count", async (t) => {
	const h = await harness(t);
	await h.voice("history");
	assert.match(h.notices.at(-1).text, /No dictation recorded yet/);
	await h.voice("toggle"); h.complete("Review this mistake"); h.poll();
	await h.voice("history 1");
	assert.match(h.notices.at(-1).text, /Review this mistake/);
	assert.match(h.notices.at(-1).text, /1 newest/);
	assert.ok(h.notices.at(-1).text.includes(getHistoryDir()));
	for (const argument of ["0", "51", "abc", "1 extra"]) {
		await h.voice("history " + argument);
		assert.equal(h.notices.at(-1).level, "warning");
		assert.match(h.notices.at(-1).text, /Usage:/);
	}
});
