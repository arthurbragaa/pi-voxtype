import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { createHash, randomUUID } from "node:crypto";
import { appendHistory, displayText, getHistoryDir, readRecentHistory, type DictationRecord } from "./history.ts";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import os from "node:os";

type BusyMode = "steer" | "followUp";
type VoiceState = "idle" | "recording" | "streaming" | "transcribing" | "unknown";

type PersistedConfig = {
	enabled?: boolean;
	busyMode?: BusyMode;
	inboxFile?: string;
};

type ShellResult = {
	ok: boolean;
	stdout?: string;
	error?: string;
};

type DoctorReport = {
	issues: string[];
	notes: string[];
	actions: string[];
};

type ActiveOwner = {
	inboxFile: string;
	sessionFile?: string;
	pid: number;
	updatedAt: string;
};

const STATUS_ID = "pi-voxtype-status";
const WIDGET_ID = "pi-voxtype-widget";
const CONFIG_ENTRY = "pi-voxtype-config";
const DICTATION_ENTRY = "pi-voxtype-dictation";
const POLL_MS = 350;
const DEFAULT_SHORTCUT = process.env.PI_VOXTYPE_SHORTCUT?.trim() || "alt+space";
const runtimeDir = process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.() ?? 1000}`;
const VOICE_RUNTIME_DIR = join(runtimeDir, "pi-voxtype");
const ACTIVE_OWNER_FILE = join(VOICE_RUNTIME_DIR, "active-owner.json");
const DEFAULT_INBOX_ENV = process.env.PI_VOXTYPE_INBOX;
const DEFAULT_INBOX_FILE = DEFAULT_INBOX_ENV || join(VOICE_RUNTIME_DIR, "inbox.txt");

function expandHome(path: string): string {
	if (path === "~") return os.homedir();
	if (path.startsWith("~/")) return join(os.homedir(), path.slice(2));
	return path;
}

function resolveInboxFile(path?: string, fallbackPath = DEFAULT_INBOX_FILE): string {
	const next = path?.trim() || fallbackPath;
	return resolve(expandHome(next));
}

function getSessionDefaultInboxFile(ctx: ExtensionContext): string {
	if (DEFAULT_INBOX_ENV?.trim()) return resolveInboxFile(DEFAULT_INBOX_ENV);

	const sessionFile = ctx.sessionManager.getSessionFile();
	const sessionKey = sessionFile || `pid:${process.pid}`;
	const hash = createHash("sha1").update(sessionKey).digest("hex").slice(0, 12);
	return join(VOICE_RUNTIME_DIR, `${hash}.inbox.txt`);
}

function resolveVoxtypeStateFile(): string | undefined {
	const configPath = join(os.homedir(), ".config", "voxtype", "config.toml");
	const autoPath = join(runtimeDir, "voxtype", "state");

	if (!existsSync(configPath)) return autoPath;

	try {
		const content = readFileSync(configPath, "utf8");
		const match = content.match(/^\s*state_file\s*=\s*"([^"]+)"/m);
		if (!match) return autoPath;

		const value = match[1].trim();
		if (value === "auto") return autoPath;
		if (value === "disabled") return undefined;
		return resolve(expandHome(value));
	} catch {
		return autoPath;
	}
}

function normalizeVoiceState(value: string | undefined): VoiceState {
	switch ((value || "").trim()) {
		case "idle":
			return "idle";
		case "recording":
			return "recording";
		case "streaming":
			return "streaming";
		case "transcribing":
		case "outputting":
			return "transcribing";
		default:
			return "unknown";
	}
}

function voiceIcon(state: VoiceState): string {
	switch (state) {
		case "recording":
		case "streaming":
			return "🎤";
		case "transcribing":
			return "⏳";
		default:
			return "🎙️";
	}
}

function shQuote(value: string): string {
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export default function piVoiceExtension(pi: ExtensionAPI) {
	let currentCtx: ExtensionContext | undefined;
	let enabled = false;
	let busyMode: BusyMode = "followUp";
	let sessionDefaultInboxFile = DEFAULT_INBOX_FILE;
	let inboxFile = resolveInboxFile(undefined, sessionDefaultInboxFile);
	let voxtypeStateFile = resolveVoxtypeStateFile();
	let voxtypeState: VoiceState = "idle";

	let pollHandle: NodeJS.Timeout | undefined;
	let lastCompletionMtimeMs = 0;
	let lastOwnerSignature = "";
	let commandInFlight = false;
	let lastToggleAt = -Infinity;
	let ignoreCompletions = false;
	let disposed = false;
	let recordingMetadata: DictationRecord["voxtype"];
	const persistenceWarnings = new Set<string>();

	const clearWidgetUi = () => {
		if (!currentCtx?.hasUI) return;
		currentCtx.ui.setWidget(WIDGET_ID, undefined);
	};

	const readActiveOwner = (): ActiveOwner | undefined => {
		try {
			return JSON.parse(readFileSync(ACTIVE_OWNER_FILE, "utf8")) as ActiveOwner;
		} catch {
			return undefined;
		}
	};

	const writeActiveOwner = () => {
		mkdirSync(dirname(ACTIVE_OWNER_FILE), { recursive: true });
		const owner: ActiveOwner = {
			inboxFile,
			sessionFile: currentCtx?.sessionManager.getSessionFile() || undefined,
			pid: process.pid,
			updatedAt: new Date().toISOString(),
		};
		const temporary = `${ACTIVE_OWNER_FILE}.${process.pid}.tmp`;
		writeFileSync(temporary, JSON.stringify(owner, null, 2), { mode: 0o600 });
		renameSync(temporary, ACTIVE_OWNER_FILE);
		lastOwnerSignature = `${owner.inboxFile}:${owner.updatedAt}`;
	};

	const clearActiveOwnerIfCurrent = () => {
		const owner = readActiveOwner();
		if (!owner || owner.inboxFile !== inboxFile) return;
		writeFileSync(ACTIVE_OWNER_FILE, "");
		lastOwnerSignature = "";
	};

	const isCurrentSessionActiveOwner = () => {
		const owner = readActiveOwner();
		if (!owner) return false;
		return owner.inboxFile === inboxFile;
	};

	const applyUi = () => {
		if (!currentCtx?.hasUI) return;
		clearWidgetUi();
		const shouldShow = enabled && voxtypeState !== "idle" && isCurrentSessionActiveOwner();
		currentCtx.ui.setStatus(STATUS_ID, shouldShow ? voiceIcon(voxtypeState) : undefined);
	};

	const persistConfig = () => {
		pi.appendEntry(CONFIG_ENTRY, {
			enabled,
			busyMode,
			inboxFile,
		} satisfies PersistedConfig);
	};

	const armInboxSnapshot = () => {
		try {
			lastCompletionMtimeMs = statSync(`${inboxFile}.done`).mtimeMs;
		} catch {
			lastCompletionMtimeMs = 0;
		}
	};

	const readVoxtypeState = (): VoiceState => {
		if (!voxtypeStateFile) return "unknown";
		try {
			return normalizeVoiceState(readFileSync(voxtypeStateFile, "utf8"));
		} catch {
			return "unknown";
		}
	};

	const loadConfig = (ctx: ExtensionContext) => {
		enabled = false;
		busyMode = "followUp";
		sessionDefaultInboxFile = getSessionDefaultInboxFile(ctx);
		inboxFile = resolveInboxFile(undefined, sessionDefaultInboxFile);
		voxtypeStateFile = resolveVoxtypeStateFile();

		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== CONFIG_ENTRY || !entry.data) continue;
			const data = entry.data as PersistedConfig;
			enabled = Boolean(data.enabled);
			busyMode = data.busyMode === "steer" ? "steer" : "followUp";
			inboxFile = data.inboxFile
				? resolveInboxFile(data.inboxFile, sessionDefaultInboxFile)
				: sessionDefaultInboxFile;
		}

		armInboxSnapshot();
		voxtypeState = readVoxtypeState();
		applyUi();
	};

	const sendTranscript = (text: string): Pick<DictationRecord, "delivery" | "busyMode" | "error"> => {
		const trimmed = text.trim();
		if (!currentCtx || !trimmed) return { delivery: "not-submitted", busyMode: null };
		try {
			if (currentCtx.isIdle()) {
				pi.sendUserMessage(trimmed);
				return { delivery: "submitted", busyMode: null };
			}
			pi.sendUserMessage(trimmed, { deliverAs: busyMode });
			return { delivery: "queued", busyMode };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (currentCtx.hasUI) currentCtx.ui.notify(`Voice send failed: ${message}`, "error");
			return { delivery: "failed", busyMode: null, error: message };
		}
	};

	const warnPersistence = (kind: string, error: unknown) => {
		if (persistenceWarnings.has(kind)) return;
		persistenceWarnings.add(kind);
		if (currentCtx?.hasUI) currentCtx.ui.notify(`Could not save dictation ${kind}: ${error}. Voice delivery continues.`, "warning");
	};

	const recordDictation = (outcome: DictationRecord["outcome"], transcript: string, error?: string) => {
		if (!currentCtx) return;
		const delivery: Pick<DictationRecord, "delivery" | "busyMode" | "error"> = outcome === "ok"
			? sendTranscript(transcript) : { delivery: "not-submitted", busyMode: null };
		const record: DictationRecord = {
			schemaVersion: 1,
			id: randomUUID(),
			timestamp: new Date().toISOString(),
			source: "dictation",
			scope: "pi",
			sessionId: currentCtx.sessionManager.getSessionId(),
			sessionFile: currentCtx.sessionManager.getSessionFile() || null,
			cwd: currentCtx.cwd || null,
			outcome,
			...delivery,
			transcript,
			submittedText: outcome === "ok" && delivery.delivery !== "failed" ? transcript.trim() : "",
			...(error || delivery.error ? { error: error || delivery.error } : {}),
			voxtype: recordingMetadata,
		};
		try {
			appendHistory(record);
		} catch (error) {
			warnPersistence("history", error);
		}
		try {
			// Custom entries and labels are durable UI provenance, never model context.
			pi.appendEntry(DICTATION_ENTRY, record);
			const entryId = currentCtx.sessionManager.getLeafId();
			if (entryId) pi.setLabel(entryId, "🎙 Dictation");
		} catch (error) {
			warnPersistence("session marker", error);
		}
	};

	const poll = () => {
		if (!currentCtx || disposed || commandInFlight) return;

		const owner = readActiveOwner();
		const ownerSignature = owner ? `${owner.inboxFile}:${owner.updatedAt}` : "";
		const nextState = readVoxtypeState();
		if (nextState !== voxtypeState || ownerSignature !== lastOwnerSignature) {
			voxtypeState = nextState;
			lastOwnerSignature = ownerSignature;
			applyUi();
		}

		if (!enabled || ignoreCompletions) return;

		try {
			// Voxtype >=1.0 publishes this atomically AFTER the full transcript.
			// Never submit incremental file writes or individual streaming chunks.
			const completionFile = `${inboxFile}.done`;
			const stats = statSync(completionFile);
			if (stats.mtimeMs === lastCompletionMtimeMs) return;
			const outcome = JSON.parse(readFileSync(completionFile, "utf8"));
			if (!["ok", "empty", "error"].includes(outcome.status)) return;
			const text = outcome.status === "ok" ? readFileSync(inboxFile, "utf8") : "";
			lastCompletionMtimeMs = stats.mtimeMs;
			clearActiveOwnerIfCurrent();
			applyUi();
			recordDictation(outcome.status, text, outcome.status === "error" ? String(outcome.message || "unknown error") : undefined);
			if (currentCtx.hasUI && outcome.status === "error") {
				currentCtx.ui.notify(`Voice transcription failed: ${outcome.message || "unknown error"}`, "error");
			} else if (currentCtx.hasUI && outcome.status === "empty") {
				currentCtx.ui.notify("No speech detected", "info");
			}
		} catch {
			// No completion yet (or a failed read); retry on the next poll.
		}
	};

	const ensurePolling = () => {
		if (pollHandle) return;
		pollHandle = setInterval(poll, POLL_MS);
	};

	const stopPolling = () => {
		if (!pollHandle) return;
		clearInterval(pollHandle);
		pollHandle = undefined;
	};

	const runShellCommand = async (command: string): Promise<ShellResult> => {
		try {
			const result = await pi.exec("bash", ["-lc", command], { timeout: 15_000 });
			if (result.code === 0) return { ok: true, stdout: result.stdout };
			return {
				ok: false,
				stdout: result.stdout,
				error: (result.stderr || result.stdout || `exit ${result.code}`).trim(),
			};
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
	};

	const prepareInbox = () => {
		mkdirSync(dirname(inboxFile), { recursive: true });
		rmSync(`${inboxFile}.done`, { force: true });
		writeFileSync(inboxFile, "", { mode: 0o600 });
		ignoreCompletions = false;
		armInboxSnapshot();
	};

	const checkFileTransport = async (captureMetadata = false): Promise<string | undefined> => {
		const result = await runShellCommand("voxtype config schema --json");
		if (!result.ok) return "Voxtype >=1.0 is required for completed transcript delivery.";
		try {
			const schema = JSON.parse(result.stdout || "{}");
			if (!schema.daemon_version) return "Voxtype daemon is not running.";
			// The schema describes the CLI's config, not an older daemon's config.
			if (schema.daemon_version !== schema.voxtype_version) {
				return "Voxtype CLI and daemon versions differ; restart voxtype first.";
			}
			const value = (key: string) => schema.keys?.find((entry: { key: string }) => entry.key === key)?.value;
			const streaming = (schema.engine === "parakeet" && value("parakeet.streaming") === true)
				|| (schema.engine === "soniox" && value("soniox.async_api") !== true);
			if (streaming && schema.capabilities?.streaming_file_output !== true) {
				return "This Voxtype build does not advertise verified streaming file completion. Use the streaming-file-output compatibility build or a non-streaming model.";
			}
			if (captureMetadata) {
				recordingMetadata = {
					version: schema.voxtype_version,
					engine: schema.engine,
					model: value(`${schema.engine}.model`),
					textSettings: Object.fromEntries((schema.keys || [])
						.filter((entry: { key: string }) => entry.key.startsWith("text."))
						.map((entry: { key: string; value: unknown }) => [entry.key, entry.value])),
					replacements: schema.replacements || {},
				};
			}
		} catch {
			return "Cannot read Voxtype's config schema; refusing to start an unverified file recording.";
		}
		return undefined;
	};

	const cancelRecording = async (ctx: ExtensionContext) => {
		if (commandInFlight) {
			ctx.ui.notify("Voice start/stop is still in progress; retry /voice cancel shortly.", "warning");
			return;
		}
		ignoreCompletions = true; // A late result must never be submitted after cancel.
		if (!isCurrentSessionActiveOwner()) return;
		commandInFlight = true;
		try {
			const result = await runShellCommand("voxtype record cancel");
			if (!result.ok) {
				ctx.ui.notify(`Voice cancel failed: ${result.error}`, "error");
				return;
			}
			clearActiveOwnerIfCurrent();
			voxtypeState = readVoxtypeState();
			applyUi();
		} finally {
			commandInFlight = false;
		}
	};

	const toggleRecording = async (ctx: ExtensionContext) => {
		const now = Date.now();
		const repeated = now - lastToggleAt < 750;
		lastToggleAt = now; // Holding the shortcut extends the debounce window.
		if (disposed || commandInFlight || repeated) return;
		currentCtx = ctx;
		ensurePolling();
		// Read now, not the potentially stale state from the 350ms poll.
		voxtypeState = readVoxtypeState();
		if (voxtypeState === "unknown") {
			ctx.ui.notify("Cannot read Voxtype state. Run /voice doctor before recording.", "warning");
			return;
		}
		if (voxtypeState === "transcribing") {
			ctx.ui.notify("Voice is still transcribing. Wait, or use /voice cancel.", "info");
			return;
		}
		const action = voxtypeState === "recording" || voxtypeState === "streaming" ? "stop" : "start";
		if (action === "stop" && !isCurrentSessionActiveOwner()) {
			ctx.ui.notify("That recording belongs to another pi session or desktop dictation.", "warning");
			return;
		}
		// Deliver a just-finished take before preparing (and truncating) its inbox.
		if (action === "start") poll();
		commandInFlight = true;
		try {
			if (action === "start") {
				const issue = await checkFileTransport(true);
				if (disposed) return;
				if (issue) {
					ctx.ui.notify(issue, "warning");
					return;
				}
				// Another client may have started while the preflight was running.
				if (readVoxtypeState() !== "idle") {
					ctx.ui.notify("Voxtype became busy; try again after that recording finishes.", "warning");
					return;
				}
				prepareInbox();
				writeActiveOwner();
			}
			enabled = true;
			persistConfig();
			const command = action === "start"
				? `voxtype record start --no-auto-submit --no-smart-auto-submit --no-osd --file=${shQuote(inboxFile)}`
				: "voxtype record stop";
			const result = await runShellCommand(command);
			if (disposed) {
				if (isCurrentSessionActiveOwner()) {
					await runShellCommand("voxtype record cancel");
					clearActiveOwnerIfCurrent();
				}
				return;
			}
			if (!result.ok) {
				if (action === "start") clearActiveOwnerIfCurrent();
				ctx.ui.notify(`Voice ${action} failed: ${result.error || "unknown error"}`, "error");
				return;
			}
			voxtypeState = action === "start" ? "recording" : "transcribing";
			applyUi();
		} catch (error) {
			if (action === "start") clearActiveOwnerIfCurrent();
			ctx.ui.notify(`Voice ${action} failed: ${String(error)}`, "error");
		} finally {
			commandInFlight = false;
		}
	};

	const runDoctor = async (): Promise<DoctorReport> => {
		const issues: string[] = [];
		const notes: string[] = [];
		const actions: string[] = [];

		const voxtype = await runShellCommand("command -v voxtype >/dev/null 2>&1");
		if (!voxtype.ok) {
			issues.push("voxtype is not installed or not on PATH.");
			actions.push("Install voxtype and verify `voxtype config` works before using pi-voxtype.");
			return { issues, notes, actions };
		}
		notes.push("voxtype found on PATH.");
		notes.push(`always-on dictation history: ${getHistoryDir()} (text only)`);
		const transportIssue = await checkFileTransport();
		if (transportIssue) issues.push(transportIssue);
		else notes.push("Completed file transcript delivery is supported by the running daemon.");

		const status = await runShellCommand("voxtype status --format json >/dev/null 2>&1");
		if (status.ok) {
			notes.push("voxtype daemon is reachable.");
		} else {
			issues.push("voxtype daemon is not reachable.");
			actions.push("Start it with `voxtype`, or use `voxtype setup systemd` for a user service.");
		}

		if (voxtypeStateFile) {
			if (existsSync(voxtypeStateFile)) {
				notes.push(`state file: ${voxtypeStateFile}`);
			} else {
				notes.push(`state file path: ${voxtypeStateFile} (created by voxtype when active)`);
			}
		} else {
			issues.push("voxtype state_file is disabled, so the live recording icon cannot update.");
			actions.push("Set `state_file = \"auto\"` in ~/.config/voxtype/config.toml if you want live status.");
		}

		try {
			mkdirSync(dirname(inboxFile), { recursive: true });
			writeFileSync(inboxFile, "", { flag: "a" });
			notes.push(`inbox writable: ${inboxFile}`);
		} catch (error) {
			issues.push(`cannot write inbox file: ${error instanceof Error ? error.message : String(error)}`);
			actions.push("Set `PI_VOXTYPE_INBOX` to another file or fix permissions on the runtime directory.");
		}

		return { issues, notes, actions };
	};

	const shortcutLabel = () => (DEFAULT_SHORTCUT.toLowerCase() === "off" ? "disabled" : DEFAULT_SHORTCUT);

	pi.registerEntryRenderer<DictationRecord>(DICTATION_ENTRY, (entry, { expanded }, theme) => {
		const record = entry.data;
		if (!record) return undefined;
		const status = record.outcome !== "ok" ? record.outcome
			: record.delivery === "queued" ? `queued ${record.busyMode}` : record.delivery;
		const heading = `🎙 Dictation · ${status} · ${record.timestamp.slice(11, 19)} UTC`;
		const details = expanded ? `\n${displayText(record.transcript || record.error || "No speech detected")}\nHistory ID: ${record.id}` : "";
		return new Text(theme.fg("accent", heading) + details, 1, 0);
	});

	pi.on("session_start", async (_event, ctx) => {
		currentCtx = ctx;
		loadConfig(ctx);
		ensurePolling();
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		disposed = true;
		ignoreCompletions = true;
		stopPolling();
		// session_start is re-fired for resume/fork/reload by current pi.
		// Never leave an owned microphone recording behind when its session exits.
		if (!commandInFlight && isCurrentSessionActiveOwner()) {
			await runShellCommand("voxtype record cancel");
			clearActiveOwnerIfCurrent();
		}
		ctx.ui.setStatus(STATUS_ID, undefined);
		ctx.ui.setWidget(WIDGET_ID, undefined);
		currentCtx = undefined;
	});

	if (shortcutLabel() !== "disabled") {
		pi.registerShortcut(DEFAULT_SHORTCUT as any, {
			description: "Voice recording toggle",
			handler: async (ctx) => {
				await toggleRecording(ctx);
			},
		});
	}

	pi.registerCommand("voice", {
		description: "Bridge voxtype transcripts into pi",
		getArgumentCompletions: (prefix) => {
			const args = ["status", "toggle", "cancel", "on", "off", "doctor", "history", "steer", "followup"];
			const filtered = args.filter((value) => value.startsWith(prefix.trim().toLowerCase()));
			return filtered.length > 0 ? filtered.map((value) => ({ value, label: value })) : null;
		},
		handler: async (args, ctx) => {
			currentCtx = ctx;
			ensurePolling();

			const [command = "status", ...rest] = args.trim().split(/\s+/).filter(Boolean);
			switch (command.toLowerCase()) {
				case "history": {
					const count = rest.length === 0 ? 10 : Number(rest[0]);
					if (rest.length > 1 || !Number.isInteger(count) || count < 1 || count > 50) {
						ctx.ui.notify("Usage: /voice history [1-50]", "warning");
						return;
					}
					try {
						const records = readRecentHistory(count);
						const lines = records.map((record) => {
							const text = displayText(record.transcript || record.error || "No speech detected");
							const preview = text.length > 1000 ? text.slice(0, 1000) + "…" : text;
							return `${record.timestamp} · ${record.outcome}/${record.delivery} · ${record.id.slice(0, 8)}\n${preview}`;
						});
						ctx.ui.notify(`Dictation history (${records.length} newest, across Pi sessions)\n${getHistoryDir()}\n\n${lines.join("\n\n") || "No dictation recorded yet."}`, "info");
					} catch (error) {
						ctx.ui.notify(`Cannot read dictation history: ${error}`, "error");
					}
					return;
				}
				case "toggle": {
					await toggleRecording(ctx);
					return;
				}
				case "cancel": {
					await cancelRecording(ctx);
					return;
				}
				case "on": {
					enabled = true;
					ignoreCompletions = false;
					armInboxSnapshot();
					persistConfig();
					applyUi();
					ctx.ui.notify("Voice bridge enabled", "info");
					return;
				}
				case "off": {
					await cancelRecording(ctx);
					enabled = false;
					persistConfig();
					applyUi();
					ctx.ui.notify("Voice bridge disabled", "info");
					return;
				}
				case "steer": {
					busyMode = "steer";
					persistConfig();
					ctx.ui.notify("Voice busy mode set to steer", "info");
					return;
				}
				case "followup":
				case "follow-up": {
					busyMode = "followUp";
					persistConfig();
					ctx.ui.notify("Voice busy mode set to follow-up", "info");
					return;
				}
				case "doctor": {
					const report = await runDoctor();
					const lines = [
						report.issues.length === 0 ? "Voice doctor: OK" : `Voice doctor: ${report.issues.length} issue(s)`,
						...report.notes.map((note) => `- ${note}`),
						...report.issues.map((issue) => `- ISSUE: ${issue}`),
						...report.actions.map((action) => `- NEXT: ${action}`),
					];
					ctx.ui.notify(lines.join("\n"), report.issues.length === 0 ? "info" : "warning");
					return;
				}
				case "status":
				default: {
					ctx.ui.notify(
						`Voice ${enabled ? "on" : "off"}. Shortcut: ${shortcutLabel()}. Voxtype: ${voxtypeState}. Busy: ${busyMode === "followUp" ? "follow-up" : "steer"}. Inbox: ${inboxFile}. State file: ${voxtypeStateFile || "disabled"}. History (always on): ${getHistoryDir()}.`,
						"info",
					);
					applyUi();
				}
			}
		},
	});
}
