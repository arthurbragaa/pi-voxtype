// Genuine Pi SDK/session test. Daemon CLI and model stream are isolated fakes:
// no microphone, desktop keyboard, real credentials, or provider requests.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const root = mkdtempSync(join(tmpdir(), "pi-voxtype-session-smoke-"));
process.env.HOME = join(root, "home");
process.env.XDG_RUNTIME_DIR = join(root, "runtime");
process.env.XDG_STATE_HOME = join(root, "state");
process.env.PI_OFFLINE = "1";
delete process.env.PI_VOXTYPE_INBOX;
delete process.env.PI_VOXTYPE_STATE_FILE;
let session;
let releaseBlockedRequest;
try {
	for (const directory of [process.env.HOME, process.env.XDG_RUNTIME_DIR, join(root, "bin"), join(root, "agent")]) mkdirSync(directory, { recursive: true });
	process.env.PATH = `${join(root, "bin")}:${process.env.PATH}`;
	const state = join(process.env.XDG_RUNTIME_DIR, "voxtype/state");
	mkdirSync(dirname(state)); writeFileSync(state, "idle");
	writeFileSync(join(root, "bin/voxtype"), `#!/usr/bin/env node
		const fs = require("node:fs"), path = require("node:path");
		const state = path.join(process.env.XDG_RUNTIME_DIR, "voxtype/state");
		const args = process.argv.slice(2);
		if (args[0] === "config") {
			console.log(JSON.stringify({ engine: "parakeet", voxtype_version: "test-only", daemon_version: "test-only",
				capabilities: { streaming_file_output: true }, replacements: {},
				keys: [{ key: "parakeet.streaming", value: true }, { key: "parakeet.model", value: "test-only" }] }));
		} else if (args[0] === "record") {
			fs.writeFileSync(state, args[1] === "start" ? "recording" : args[1] === "stop" ? "transcribing" : "idle");
		} else process.exit(1);
	`, { mode: 0o700 });

	const sdkLocation = process.env.PI_SDK_PATH;
	const sdkUrl = sdkLocation ? pathToFileURL(sdkLocation).href : "@earendil-works/pi-coding-agent";
	const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } = await import(sdkUrl);
	const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
	const loader = new DefaultResourceLoader({
		cwd: root, agentDir: join(root, "agent"), settingsManager,
		additionalExtensionPaths: [new URL("../index.ts", import.meta.url).pathname],
		noSkills: true, noPromptTemplates: true, noThemes: true,
	});
	await loader.reload();
	assert.deepEqual(loader.getExtensions().errors, []);
	const modelRuntime = await ModelRuntime.create({
		authPath: join(root, "agent/auth.json"), modelsPath: null,
		modelsStorePath: join(root, "agent/models-cache.json"), refreshOnCreate: false, allowModelNetwork: false,
	});
	await modelRuntime.setRuntimeApiKey("openai", "test-only-not-a-real-key");
	const model = {
		id: "local-test-only", name: "Local test", api: "openai-responses", provider: "openai",
		baseUrl: "http://127.0.0.1:1", reasoning: false, input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 512,
	};
	const manager = SessionManager.create(root, join(root, "sessions"));
	({ session } = await createAgentSession({
		cwd: root, agentDir: join(root, "agent"), model, thinkingLevel: "off", modelRuntime,
		settingsManager, resourceLoader: loader, sessionManager: manager, tools: [],
	}));
	const modelContexts = [];
	let gate;
	session.agent.streamFunction = (_model, context) => {
		modelContexts.push(context);
		const message = {
			role: "assistant", content: [{ type: "text", text: "Test response" }], api: model.api,
			provider: model.provider, model: model.id, stopReason: "stop", timestamp: Date.now(),
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		};
		const wait = gate;
		gate = undefined;
		return {
			async *[Symbol.asyncIterator]() {
				yield { type: "start", partial: message };
				if (wait) await wait;
				yield { type: "done", reason: "stop", message };
			},
			result: async () => message,
		};
	};
	await session.bindExtensions({});
	await session.prompt("/voice toggle");
	const owner = JSON.parse(readFileSync(join(process.env.XDG_RUNTIME_DIR, "pi-voxtype/active-owner.json"), "utf8"));
	const transcript = "  A genuine Pi dictation provenance test.\n";
	writeFileSync(owner.inboxFile, transcript);
	writeFileSync(owner.inboxFile + ".done", JSON.stringify({ status: "ok" }));
	writeFileSync(state, "idle");
	const deadline = Date.now() + 5000;
	while (Date.now() < deadline && !manager.getEntries().some((entry) => entry.type === "message" && entry.message.role === "assistant")) {
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	await session.waitForIdle();
	const entries = manager.getEntries();
	const markers = entries.filter((entry) => entry.type === "custom" && entry.customType === "pi-voxtype-dictation");
	assert.equal(markers.length, 1);
	assert.equal(manager.getLabel(markers[0].id), "🎙 Dictation");
	assert.equal(markers[0].data.transcript, transcript);
	const renderer = session.extensionRunner.getEntryRenderer("pi-voxtype-dictation");
	const rendered = renderer(markers[0], { expanded: true }, { fg: (_color, text) => text }).render(80).join("\n");
	assert.match(rendered, /🎙 Dictation/);
	assert.match(rendered, /A genuine Pi dictation provenance test/);
	const userMessages = entries.filter((entry) => entry.type === "message" && entry.message.role === "user");
	assert.equal(userMessages.length, 1);
	assert.deepEqual(userMessages[0].message.content, [{ type: "text", text: transcript.trim() }]);
	assert.equal(modelContexts.length, 1);
	assert.ok(modelContexts[0].messages.every((message) => message.role !== "custom"));
	assert.equal(JSON.stringify(modelContexts[0]).includes("🎙 Dictation"), false);
	const historyDirectory = join(process.env.XDG_STATE_HOME, "pi-voxtype/transcriptions");
	const historyFile = join(historyDirectory, markers[0].data.timestamp.slice(0, 10) + ".jsonl");
	assert.equal(JSON.parse(readFileSync(historyFile, "utf8")).id, markers[0].data.id);
	const reopened = SessionManager.open(manager.getSessionFile());
	assert.equal(reopened.getLabel(markers[0].id), "🎙 Dictation");
	assert.equal(reopened.getEntries().filter((entry) => entry.type === "custom" && entry.customType === "pi-voxtype-dictation").length, 1);
	gate = new Promise((resolve) => { releaseBlockedRequest = resolve; });
	const busyPrompt = session.prompt("Typed message to keep Pi busy");
	const busyDeadline = Date.now() + 5000;
	while (modelContexts.length < 2 && Date.now() < busyDeadline) await new Promise((resolve) => setTimeout(resolve, 10));
	assert.equal(modelContexts.length, 2);
	await new Promise((resolve) => setTimeout(resolve, 800)); // Respect the shortcut repeat guard.
	await session.prompt("/voice toggle");
	const queuedOwner = JSON.parse(readFileSync(join(process.env.XDG_RUNTIME_DIR, "pi-voxtype/active-owner.json"), "utf8"));
	writeFileSync(queuedOwner.inboxFile, "A queued dictated message.");
	writeFileSync(queuedOwner.inboxFile + ".done", JSON.stringify({ status: "ok" }));
	writeFileSync(state, "idle");
	const queuedDeadline = Date.now() + 5000;
	while (Date.now() < queuedDeadline && manager.getEntries().filter((entry) => entry.customType === "pi-voxtype-dictation").length < 2) {
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	const queuedMarker = manager.getEntries().filter((entry) => entry.customType === "pi-voxtype-dictation")[1];
	assert.ok(queuedMarker);
	assert.equal(queuedMarker.data.delivery, "queued");
	assert.equal(queuedMarker.data.busyMode, "followUp");
	releaseBlockedRequest();
	await busyPrompt; await session.waitForIdle();
	assert.equal(modelContexts.length, 3);
	assert.ok(modelContexts.every((context) => !JSON.stringify(context).includes("🎙 Dictation")));
	assert.equal(manager.getEntries().filter((entry) => entry.type === "message" && entry.message.role === "user").length, 3);
	assert.equal(readFileSync(historyFile, "utf8").trim().split("\n").length, 2, "Typed messages are not dictation logs");
	console.log("PASS genuine Pi SDK: idle + queued dictation, unchanged messages, durable rendered markers/tree labels, private history, provenance excluded from model context");
} finally {
	releaseBlockedRequest?.();
	if (session) {
		await session.abort();
		if (session.extensionRunner) await session.extensionRunner.emit({ type: "session_shutdown" });
		session.dispose();
	}
	rmSync(root, { recursive: true, force: true });
}
