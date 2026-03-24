import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import os from "node:os";

type BusyMode = "steer" | "followUp";
type VoiceState = "idle" | "recording" | "transcribing";

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
const LEGACY_WIDGET_ID = "pi-voxtype-widget";
const CONFIG_ENTRY = "pi-voxtype-config";
const POLL_MS = 350;
const DEFAULT_SHORTCUT = process.env.PI_VOXTYPE_SHORTCUT?.trim() || process.env.PI_VOICE_SHORTCUT?.trim() || "alt+space";
const runtimeDir = process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.() ?? 1000}`;
const VOICE_RUNTIME_DIR = join(runtimeDir, "pi-voxtype");
const ACTIVE_OWNER_FILE = join(VOICE_RUNTIME_DIR, "active-owner.json");
const DEFAULT_INBOX_ENV = process.env.PI_VOXTYPE_INBOX || process.env.PI_VOICE_INBOX;
const LEGACY_DEFAULT_INBOX_FILE = DEFAULT_INBOX_ENV || join(VOICE_RUNTIME_DIR, "inbox.txt");

function expandHome(path: string): string {
	if (path === "~") return os.homedir();
	if (path.startsWith("~/")) return join(os.homedir(), path.slice(2));
	return path;
}

function resolveInboxFile(path?: string, fallbackPath = LEGACY_DEFAULT_INBOX_FILE): string {
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
		case "recording":
			return "recording";
		case "transcribing":
			return "transcribing";
		default:
			return "idle";
	}
}

function voiceIcon(state: VoiceState): string {
	switch (state) {
		case "recording":
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
	let sessionDefaultInboxFile = LEGACY_DEFAULT_INBOX_FILE;
	let inboxFile = resolveInboxFile(undefined, sessionDefaultInboxFile);
	let voxtypeStateFile = resolveVoxtypeStateFile();
	let voxtypeState: VoiceState = "idle";

	let pollHandle: NodeJS.Timeout | undefined;
	let lastInboxMtimeMs = 0;
	let lastInboxContent = "";
	let lastStateMtimeMs = 0;
	let lastOwnerSignature = "";

	const clearLegacyUi = () => {
		if (!currentCtx?.hasUI) return;
		currentCtx.ui.setWidget(LEGACY_WIDGET_ID, undefined);
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
		writeFileSync(ACTIVE_OWNER_FILE, JSON.stringify(owner, null, 2));
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
		clearLegacyUi();
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
			const stats = statSync(inboxFile);
			lastInboxMtimeMs = stats.mtimeMs;
			lastInboxContent = readFileSync(inboxFile, "utf8");
		} catch {
			lastInboxMtimeMs = 0;
			lastInboxContent = "";
		}
	};

	const readVoxtypeState = (): VoiceState => {
		if (!voxtypeStateFile) return "idle";

		try {
			const stats = statSync(voxtypeStateFile);
			if (stats.mtimeMs !== lastStateMtimeMs) lastStateMtimeMs = stats.mtimeMs;
			return normalizeVoiceState(readFileSync(voxtypeStateFile, "utf8").trim());
		} catch {
			return "idle";
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

			const persistedInboxFile = data.inboxFile
				? resolveInboxFile(data.inboxFile, sessionDefaultInboxFile)
				: sessionDefaultInboxFile;
			const shouldMigrateLegacyInbox =
				!DEFAULT_INBOX_ENV?.trim() && persistedInboxFile === resolveInboxFile(undefined, LEGACY_DEFAULT_INBOX_FILE);
			inboxFile = shouldMigrateLegacyInbox ? sessionDefaultInboxFile : persistedInboxFile;
		}

		armInboxSnapshot();
		voxtypeState = readVoxtypeState();
		applyUi();
	};

	const sendTranscript = (text: string) => {
		if (!currentCtx) return;

		const trimmed = text.trim();
		if (!trimmed) return;

		try {
			if (currentCtx.isIdle()) {
				pi.sendUserMessage(trimmed);
			} else {
				pi.sendUserMessage(trimmed, { deliverAs: busyMode });
			}
		} catch (error) {
			if (!currentCtx.hasUI) return;
			const message = error instanceof Error ? error.message : String(error);
			currentCtx.ui.notify(`Voice send failed: ${message}`, "error");
		}
	};

	const poll = () => {
		if (!currentCtx) return;

		const owner = readActiveOwner();
		const ownerSignature = owner ? `${owner.inboxFile}:${owner.updatedAt}` : "";
		const nextState = readVoxtypeState();
		if (nextState !== voxtypeState || ownerSignature !== lastOwnerSignature) {
			voxtypeState = nextState;
			lastOwnerSignature = ownerSignature;
			if (voxtypeState === "idle") clearActiveOwnerIfCurrent();
			applyUi();
		}

		if (!enabled) return;

		try {
			const stats = statSync(inboxFile);
			if (stats.mtimeMs <= lastInboxMtimeMs) return;

			const nextContent = readFileSync(inboxFile, "utf8");
			const delta = nextContent.startsWith(lastInboxContent)
				? nextContent.slice(lastInboxContent.length)
				: nextContent;

			lastInboxMtimeMs = stats.mtimeMs;
			lastInboxContent = nextContent;
			sendTranscript(delta);
		} catch {
			// Inbox appears only after the first recording starts.
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
		writeFileSync(inboxFile, "");
		armInboxSnapshot();
	};

	const getStartCommand = () => `voxtype record start --file=${shQuote(inboxFile)}`;
	const getStopCommand = () => "voxtype record stop";

	const toggleRecording = async (ctx: ExtensionContext) => {
		currentCtx = ctx;
		ensurePolling();
		enabled = true;
		persistConfig();

		const action = voxtypeState === "recording" ? "stop" : "start";
		if (action === "start") prepareInbox();

		const result = await runShellCommand(action === "stop" ? getStopCommand() : getStartCommand());
		if (result.ok) {
			if (action === "start") writeActiveOwner();
			voxtypeState = action === "start" ? "recording" : "transcribing";
			applyUi();
			return;
		}

		applyUi();
		if (ctx.hasUI) {
			ctx.ui.notify(`Voice ${action} failed: ${result.error || "unknown error"}`, "error");
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
			actions.push("Choose another path with `/voice path <file>` or fix permissions on the runtime directory.");
		}

		return { issues, notes, actions };
	};

	const shortcutLabel = () => (DEFAULT_SHORTCUT.toLowerCase() === "off" ? "disabled" : DEFAULT_SHORTCUT);

	pi.on("session_start", async (_event, ctx) => {
		currentCtx = ctx;
		loadConfig(ctx);
		ensurePolling();
	});

	pi.on("session_switch", async (_event, ctx) => {
		currentCtx = ctx;
		loadConfig(ctx);
		ensurePolling();
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		ctx.ui.setStatus(STATUS_ID, undefined);
		ctx.ui.setWidget(LEGACY_WIDGET_ID, undefined);
		stopPolling();
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
			const args = ["status", "toggle", "on", "off", "setup", "doctor", "steer", "followup", "path", "test"];
			const filtered = args.filter((value) => value.startsWith(prefix.trim().toLowerCase()));
			return filtered.length > 0 ? filtered.map((value) => ({ value, label: value })) : null;
		},
		handler: async (args, ctx) => {
			currentCtx = ctx;
			ensurePolling();

			const [command = "status", ...rest] = args.trim().split(/\s+/).filter(Boolean);
			switch (command.toLowerCase()) {
				case "toggle": {
					await toggleRecording(ctx);
					return;
				}
				case "on": {
					enabled = true;
					armInboxSnapshot();
					persistConfig();
					applyUi();
					ctx.ui.notify("Voice bridge enabled", "success");
					return;
				}
				case "off": {
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
				case "path": {
					if (rest.length === 0) {
						ctx.ui.notify(`Voice inbox: ${inboxFile}`, "info");
						return;
					}
					if (voxtypeState !== "idle") {
						ctx.ui.notify("Cannot change inbox while recording or transcribing.", "warning");
						return;
					}
					inboxFile = resolveInboxFile(rest.join(" "), sessionDefaultInboxFile);
					armInboxSnapshot();
					persistConfig();
					ctx.ui.notify(`Voice inbox set to ${inboxFile}`, "success");
					return;
				}
				case "setup": {
					ctx.ui.notify(
						`Shortcut: ${shortcutLabel()}. Busy mode: ${busyMode === "followUp" ? "follow-up" : "steer"}. Inbox: ${inboxFile}. Start: ${getStartCommand()} Stop: ${getStopCommand()}`,
						"info",
					);
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
					ctx.ui.notify(lines.join("\n"), report.issues.length === 0 ? "success" : "warning");
					return;
				}
				case "test": {
					sendTranscript(rest.join(" ").trim() || "Voice bridge test.");
					return;
				}
				case "status":
				default: {
					ctx.ui.notify(
						`Voice ${enabled ? "on" : "off"}. Shortcut: ${shortcutLabel()}. Voxtype: ${voxtypeState}. Busy: ${busyMode === "followUp" ? "follow-up" : "steer"}. Inbox: ${inboxFile}. State file: ${voxtypeStateFile || "disabled"}.`,
						"info",
					);
					applyUi();
				}
			}
		},
	});
}
