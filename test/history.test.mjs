import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { appendHistory, displayText, getHistoryDir, readRecentHistory } from "../history.ts";

const root = mkdtempSync(join(tmpdir(), "pi-voxtype-history-test-"));
process.env.HOME = join(root, "home");
process.env.XDG_STATE_HOME = join(root, "state");
after(() => rmSync(root, { recursive: true, force: true }));
beforeEach(() => {
	rmSync(root, { recursive: true, force: true });
	mkdirSync(root);
	process.env.XDG_STATE_HOME = join(root, "state");
});

function record(id = "one", timestamp = "2026-09-30T12:00:00.000Z", transcript = "A dictated sentence") {
	return {
		schemaVersion: 1, id, timestamp, source: "dictation", scope: "pi",
		sessionId: "test", sessionFile: "/test/session.jsonl", cwd: "/test",
		outcome: "ok", delivery: "submitted", busyMode: null,
		transcript, submittedText: transcript.trim(),
	};
}

test("history is private, append-only, and preserves Unicode and multiline text", () => {
	const text = "Olá 🎙\nSecond line\n";
	const file = appendHistory(record("one", undefined, text));
	appendHistory(record("two"));
	assert.equal(statSync(getHistoryDir()).mode & 0o777, 0o700);
	assert.equal(statSync(file).mode & 0o777, 0o600);
	const lines = readFileSync(file, "utf8").trim().split("\n").map(JSON.parse);
	assert.equal(lines.length, 2);
	assert.equal(lines[0].transcript, text);
	assert.deepEqual(readRecentHistory().map((entry) => entry.id), ["two", "one"]);
});

test("existing overly broad history permissions are tightened", () => {
	const file = appendHistory(record());
	chmodSync(getHistoryDir(), 0o755); chmodSync(file, 0o644);
	appendHistory(record("two"));
	assert.equal(statSync(getHistoryDir()).mode & 0o777, 0o700);
	assert.equal(statSync(file).mode & 0o777, 0o600);
});

test("daily history reads newest records across dates and skips broken or unrelated lines", () => {
	appendHistory(record("old", "2026-09-29T12:00:00.000Z"));
	const file = appendHistory(record("new"));
	writeFileSync(file, '\nnot json\n{"source":"someone else"}\n{"partial":', { flag: "a" });
	assert.deepEqual(readRecentHistory(2).map((entry) => entry.id), ["new", "old"]);
	assert.deepEqual(readRecentHistory(1).map((entry) => entry.id), ["new"]);
	assert.deepEqual(readdirSync(getHistoryDir()).sort(), ["2026-09-29.jsonl", "2026-09-30.jsonl"]);
});

test("history reads a bounded tail rather than an unbounded daily file", () => {
	const file = appendHistory(record("old"));
	writeFileSync(file, "x".repeat(2 * 1024 * 1024) + "\n", { flag: "a" });
	appendHistory(record("tail"));
	assert.deepEqual(readRecentHistory().map((entry) => entry.id), ["tail"]);
});

test("missing history is empty and review count must be bounded", () => {
	assert.deepEqual(readRecentHistory(), []);
	for (const count of [0, 51, -1, 1.5, NaN]) assert.throws(() => readRecentHistory(count), /between 1 and 50/);
});

test("relative XDG_STATE_HOME falls back to the user's normal state directory", () => {
	process.env.XDG_STATE_HOME = "relative";
	assert.equal(getHistoryDir(), join(process.env.HOME, ".local/state/pi-voxtype/transcriptions"));
});

test("history rejects symlink files rather than writing dictated text somewhere else", () => {
	mkdirSync(getHistoryDir(), { recursive: true });
	const target = join(root, "outside.txt");
	writeFileSync(target, "unchanged");
	symlinkSync(target, join(getHistoryDir(), "2026-09-30.jsonl"));
	assert.throws(() => appendHistory(record()));
	assert.throws(() => readRecentHistory());
	assert.equal(readFileSync(target, "utf8"), "unchanged");
});

test("history rejects symlink directories", () => {
	const parent = join(process.env.XDG_STATE_HOME, "pi-voxtype");
	mkdirSync(parent, { recursive: true });
	const target = join(root, "outside"); mkdirSync(target);
	symlinkSync(target, getHistoryDir());
	assert.throws(() => appendHistory(record()), /symlink/);
	assert.throws(() => readRecentHistory(), /symlink/);
	assert.deepEqual(readdirSync(target), []);
});

test("invalid dates cannot become history paths", () => {
	assert.throws(() => appendHistory(record("bad", "../../oops")), /Invalid dictation history date/);
});

test("history display removes terminal control sequences without altering the archived text", () => {
	const text = "hello\x1b[31m red\x1b[0m\x07\nnext\tline";
	appendHistory(record("one", undefined, text));
	assert.equal(readRecentHistory()[0].transcript, text);
	assert.equal(displayText(text), "hello red\nnext\tline");
});
