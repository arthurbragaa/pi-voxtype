// Run only against the isolated daemon/virtual mic created by
// tests/pi_file_output_smoke.py in the local Voxtype compatibility source.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync } from "node:fs";
import { join } from "node:path";
const exec = promisify(execFile);
const [binary, config, sink, wav] = process.argv.slice(2);
assert.match(process.env.XDG_RUNTIME_DIR || "", /voxtype-file-smoke-.*\/runtime$/);
assert.match(sink || "", /^voxtype_test_sink_\d+$/);
assert.ok(binary && config && wav);
const { default: extension } = await import("../index.ts");
const events = new Map(), commands = new Map(), messages = [], notices = [];
const quote = (s) => `'${s.replaceAll("'", `'"'"'`)}'`;
const ctx = {
	hasUI: true, isIdle: () => true,
	sessionManager: { getSessionFile: () => "/isolated/bridge-smoke.jsonl", getBranch: () => [] },
	ui: { setStatus() {}, setWidget() {}, notify: (text, level) => notices.push({ text, level }) },
};
const api = {
	on: (event, fn) => events.set(event, fn),
	registerCommand: (name, cmd) => commands.set(name, cmd),
	registerShortcut() {}, appendEntry() {},
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
	await waitFor(() => state() === "recording", "bridge start");
	await sleep(250);
	await exec("pw-play", ["--target", sink, wav], { timeout: 20_000 });
	assert.equal(messages.length, 0, "No partial messages while recording");
	await commands.get("voice").handler("toggle", ctx);
	await waitFor(() => messages.length === 1, "bridge transcript delivery");
	await sleep(800);
	assert.equal(messages.length, 1, "No duplicate delivery");
	assert.match(messages[0], /ask not what your country can do for you/i);
	assert.match(messages[0], /ask what you can do for your country/i);
	await commands.get("voice").handler("toggle", ctx);
	await waitFor(() => state() === "recording", "second bridge start");
	await commands.get("voice").handler("cancel", ctx);
	await waitFor(() => state() === "idle", "bridge cancel");
	await sleep(500);
	assert.equal(messages.length, 1, "Cancellation must not send a message");
	assert.ok(!notices.some((n) => n.level === "error"), JSON.stringify(notices));
	console.log("PASS real pi extension -> real daemon -> virtual mic -> one complete collected user message; cancellation clean");
} finally {
	await events.get("session_shutdown")({ reason: "quit" }, ctx);
}
