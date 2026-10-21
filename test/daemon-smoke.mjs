// Run only against the isolated daemon/virtual mic created by
// test/file-output-smoke.py.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadExtension } from "./load-extension.mjs";
import { readRecentHistory } from "../history.ts";
const exec = promisify(execFile);
const [binary, config, sink, wav] = process.argv.slice(2);
assert.match(process.env.XDG_RUNTIME_DIR || "", /voxtype-file-smoke-.*\/runtime$/);
assert.match(sink || "", /^voxtype_test_sink_\d+$/);
assert.ok(binary && config && wav);
assert.match(process.env.XDG_STATE_HOME || "", /voxtype-file-smoke-.*\/state$/);
const extension = await loadExtension();
const events = new Map(), commands = new Map(), messages = [], notices = [], entries = [];
const quote = (s) => `'${s.replaceAll("'", `'"'"'`)}'`;
const ctx = {
	hasUI: true, isIdle: () => true,
	cwd: "/isolated/project",
	sessionManager: {
		getSessionFile: () => "/isolated/bridge-smoke.jsonl",
		getSessionId: () => "isolated-bridge-smoke",
		getLeafId: () => entries.at(-1)?.id ?? null,
		getBranch: () => entries,
	},
	ui: { setStatus() {}, setWidget() {}, notify: (text, level) => notices.push({ text, level }) },
};
const api = {
	on: (event, fn) => events.set(event, fn),
	registerCommand: (name, cmd) => commands.set(name, cmd),
	registerShortcut() {}, registerEntryRenderer() {}, setLabel() {},
	appendEntry: (customType, data) => entries.push({ type: "custom", id: String(entries.length), customType, data }),
	// Collect instead of contacting pi/a provider. All other bridge logic is real.
	sendUserMessage: (text) => messages.push(text),
	exec: async (_program, args, options) => {
		assert.equal(args[0], "-lc");
		assert.match(args[1], /^voxtype /);
		// Pin EVERY command to the isolated daemon, irrespective of login PATH.
		const command = args[1].replace(/^voxtype /, `${quote(binary)} -c ${quote(config)} `);
		try {
			const result = await exec("bash", ["-c", command], { timeout: options.timeout, maxBuffer: 1024 * 1024 });
			return { ...result, code: 0 };
		} catch (error) {
			return { code: error.code || 1, stdout: error.stdout || "", stderr: error.stderr || String(error) };
		}
	},
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const state = () => readFileSync(join(process.env.XDG_RUNTIME_DIR, "voxtype/state"), "utf8").trim();
async function waitFor(check, message) {
	const deadline = Date.now() + 20_000;
	while (Date.now() < deadline) {
		if (check()) return;
		await sleep(50);
	}
	throw new Error(`${message}; notices=${JSON.stringify(notices)}`);
}
extension(api);
await events.get("session_start")({ reason: "startup" }, ctx);
try {
	await commands.get("voice").handler("toggle", ctx);
	await waitFor(() => ["recording", "streaming"].includes(state()), "bridge start");
	await sleep(250);
	await exec("pw-play", ["--target", sink, wav], { timeout: 20_000 });
	assert.equal(messages.length, 0, "No partial messages while recording");
	await commands.get("voice").handler("toggle", ctx);
	await waitFor(() => messages.length === 1, "bridge transcript delivery");
	await sleep(800);
	assert.equal(messages.length, 1, "No duplicate delivery");
	assert.match(messages[0], /ask not what your country can do for you/i);
	assert.match(messages[0], /ask what you can do for your country/i);
	const history = readRecentHistory();
	assert.equal(history.length, 1);
	assert.equal(history[0].submittedText, messages[0]);
	assert.equal(history[0].source, "dictation");
	assert.equal(entries.filter((entry) => entry.customType === "pi-voxtype-dictation").length, 1);
	await commands.get("voice").handler("toggle", ctx);
	await waitFor(() => ["recording", "streaming"].includes(state()), "second bridge start");
	await commands.get("voice").handler("cancel", ctx);
	await waitFor(() => state() === "idle", "bridge cancel");
	await sleep(500);
	assert.equal(messages.length, 1, "Cancellation must not send a message");
	assert.ok(!notices.some((n) => n.level === "error"), JSON.stringify(notices));
	assert.equal(readRecentHistory().length, 1, "Cancelled audio must not be logged as a transcript");
	console.log("PASS real pi extension -> real daemon -> virtual mic -> one message, private history, and session marker; cancellation clean");
} finally {
	await events.get("session_shutdown")({ reason: "quit" }, ctx);
}
