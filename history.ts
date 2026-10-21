import { constants, closeSync, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, writeSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import os from "node:os";
import { stripVTControlCharacters } from "node:util";

export type DictationRecord = {
	schemaVersion: 1;
	id: string;
	timestamp: string;
	source: "dictation";
	scope: "pi";
	sessionId: string | null;
	sessionFile: string | null;
	cwd: string | null;
	outcome: "ok" | "empty" | "error";
	delivery: "submitted" | "queued" | "not-submitted" | "failed";
	busyMode: "steer" | "followUp" | null;
	/** Final Voxtype output, after its text processing; never pretend this is raw ASR. */
	transcript: string;
	submittedText: string;
	error?: string;
	voxtype?: {
		version?: string;
		engine?: string;
		model?: string;
		textSettings: Record<string, unknown>;
		replacements: Record<string, unknown>;
	};
};

const MAX_READ_BYTES = 1024 * 1024;
const DATE_FILE = /^\d{4}-\d{2}-\d{2}\.jsonl$/;

export function getHistoryDir(): string {
	const configured = process.env.XDG_STATE_HOME;
	const stateHome = configured && isAbsolute(configured) ? configured : join(os.homedir(), ".local", "state");
	return join(stateHome, "pi-voxtype", "transcriptions");
}

function checkDirectory(directory: string) {
	if (!lstatSync(directory).isDirectory()) throw new Error("Dictation history directory must not be a symlink");
}

export function appendHistory(record: DictationRecord): string {
	const directory = getHistoryDir();
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	checkDirectory(directory);
	const directoryFd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
	try {
		fchmodSync(directoryFd, 0o700);
	} finally {
		closeSync(directoryFd);
	}
	const name = `${record.timestamp.slice(0, 10)}.jsonl`;
	if (!DATE_FILE.test(name)) throw new Error("Invalid dictation history date");
	const file = join(directory, name);
	const fd = openSync(file, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
	try {
		const stats = fstatSync(fd);
		if (!stats.isFile() || stats.nlink !== 1) throw new Error("Dictation history must be a private regular file");
		fchmodSync(fd, 0o600);
		// One O_APPEND write per record also keeps concurrent Pi sessions separate.
		const line = Buffer.from(JSON.stringify(record) + "\n", "utf8");
		if (writeSync(fd, line) !== line.length) throw new Error("Incomplete dictation history write");
	} finally {
		closeSync(fd);
	}
	return file;
}

function isRecord(value: unknown): value is DictationRecord {
	if (!value || typeof value !== "object") return false;
	const record = value as DictationRecord;
	return record.schemaVersion === 1 && record.source === "dictation" && record.scope === "pi"
		&& typeof record.id === "string" && typeof record.timestamp === "string"
		&& typeof record.transcript === "string" && typeof record.submittedText === "string"
		&& ["ok", "empty", "error"].includes(record.outcome)
		&& ["submitted", "queued", "not-submitted", "failed"].includes(record.delivery);
}

export function readRecentHistory(count = 10): DictationRecord[] {
	if (!Number.isInteger(count) || count < 1 || count > 50) throw new Error("History count must be between 1 and 50");
	const directory = getHistoryDir();
	let files: string[];
	try {
		checkDirectory(directory);
		files = readdirSync(directory).filter((name) => DATE_FILE.test(name)).sort().reverse();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	const records: DictationRecord[] = [];
	for (const name of files) {
		const fd = openSync(join(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW);
		let content: string;
		try {
			const stats = fstatSync(fd);
			if (!stats.isFile()) continue;
			const offset = Math.max(0, stats.size - MAX_READ_BYTES);
			const buffer = Buffer.alloc(Math.min(stats.size, MAX_READ_BYTES));
			const bytesRead = readSync(fd, buffer, 0, buffer.length, offset);
			content = buffer.subarray(0, bytesRead).toString("utf8");
			if (offset > 0) content = content.slice(content.indexOf("\n") + 1);
		} finally {
			closeSync(fd);
		}
		for (const line of content.split("\n").reverse()) {
			try {
				const record: unknown = JSON.parse(line);
				if (isRecord(record)) records.push(record);
			} catch {
				// An interrupted append or unrelated malformed line must not hide other records.
			}
			if (records.length === count) return records;
		}
	}
	return records;
}

/** Keep terminal previews inert while retaining the exact text in the JSONL log. */
export function displayText(text: string): string {
	return stripVTControlCharacters(text).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
}
