import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Logger } from "./server.js";

const MARKER = "stream-deck-claude-code";
const EVENTS = [
	"SessionStart",
	"UserPromptSubmit",
	"PreToolUse",
	"PostToolUse",
	"PostToolUseFailure",
	"PostToolBatch",
	"Notification",
	"PermissionRequest",
	"PermissionDenied",
	"Elicitation",
	"ElicitationResult",
	"Stop",
	"StopFailure",
	"SessionEnd",
];

type HookHandler = {
	type: string;
	command?: string;
	url?: string;
	timeout?: number;
	[k: string]: unknown;
	_source?: string;
};

type HookEntry = {
	matcher?: string;
	hooks: HookHandler[];
};

type Settings = {
	hooks?: Record<string, HookEntry[]>;
	[k: string]: unknown;
};

export const settingsPath = join(homedir(), ".claude", "settings.json");
export const hooksDir = join(homedir(), ".claude", "hooks");
export const bridgeShPath = join(hooksDir, "stream-deck-bridge.sh");
export const bridgePyPath = join(hooksDir, "stream-deck-bridge.py");

/** True if any of the user's hook entries carry our marker. Used by the
 *  startup top-up so we only ADD missing events when the user has already
 *  opted in by clicking Install at some point. */
export async function isPartiallyInstalled(): Promise<boolean> {
	try {
		const raw = await fs.readFile(settingsPath, "utf8");
		const settings = JSON.parse(raw) as Settings;
		if (!settings.hooks) return false;
		for (const list of Object.values(settings.hooks)) {
			if (list.some((entry) => Array.isArray(entry?.hooks) && entry.hooks.some((h) => h?._source === MARKER))) {
				return true;
			}
		}
		return false;
	} catch {
		return false;
	}
}

export async function isInstalled(): Promise<boolean> {
	try {
		const raw = await fs.readFile(settingsPath, "utf8");
		const settings = JSON.parse(raw) as Settings;
		if (!settings.hooks) return false;
		for (const ev of EVENTS) {
			const list = settings.hooks[ev] ?? [];
			const ok = list.some(
				(e) => Array.isArray(e?.hooks) && e.hooks.some((h) => h?._source === MARKER),
			);
			if (!ok) return false;
		}
		return true;
	} catch {
		return false;
	}
}

/** Resolve an absolute interpreter path at install time so the generated
 *  shell script never depends on PATH resolution inside whatever shell
 *  Claude Code invokes hooks with. On win32 there is no `/usr/bin/python3`,
 *  and a bare `python` can hit the Microsoft Store stub (which "succeeds"
 *  but produces no interpreter) if Python isn't actually installed — so we
 *  resolve via `where` and fall back through candidates. */
function resolvePythonPath(): string {
	if (process.platform !== "win32") return "/usr/bin/python3";
	for (const candidate of ["python3", "python", "py"]) {
		try {
			const out = execFileSync("where", [candidate], { encoding: "utf8" });
			const first = out
				.split(/\r?\n/)
				.map((l) => l.trim())
				.find(Boolean);
			if (first) return first;
		} catch {
			/* candidate not on PATH — try the next one */
		}
	}
	return "python";
}

/** Claude Code invokes command-type hooks through a POSIX shell (Git Bash on
 *  Windows), which chokes on raw Windows backslash paths (they're read as
 *  escape sequences and eaten). Forward slashes are accepted by Git
 *  Bash/MSYS *and* by cmd/PowerShell, so this is safe everywhere and more
 *  robust than an `/c/`-style MSYS-only rewrite if Claude Code ever changes
 *  which shell it uses to run hooks. */
function toShellPath(p: string): string {
	return process.platform === "win32" ? p.replace(/\\/g, "/") : p;
}

export async function installHooks(port: number, logger: Logger): Promise<void> {
	await fs.mkdir(hooksDir, { recursive: true });
	await fs.mkdir(dirname(settingsPath), { recursive: true });

	const pythonPath = resolvePythonPath();

	const py = bridgePython(port);
	await fs.writeFile(bridgePyPath, py);
	await fs.chmod(bridgePyPath, 0o755);

	const sh = bridgeShell(bridgePyPath, pythonPath);
	await fs.writeFile(bridgeShPath, sh);
	await fs.chmod(bridgeShPath, 0o755);

	let settings: Settings = {};
	let raw = "";
	try {
		raw = await fs.readFile(settingsPath, "utf8");
		settings = JSON.parse(raw) as Settings;
	} catch (err) {
		if (raw) {
			try {
				await fs.writeFile(settingsPath + ".bak", raw);
			} catch {
				/* ignore */
			}
			logger.warn("existing ~/.claude/settings.json was unparseable; backed up to .bak", err);
		}
		settings = {};
	}

	settings.hooks ??= {};
	for (const ev of EVENTS) {
		const list = (settings.hooks[ev] ??= []);
		const already = list.some(
			(e) => Array.isArray(e?.hooks) && e.hooks.some((h) => h?._source === MARKER),
		);
		if (already) continue;
		list.push({
			hooks: [{ type: "command", command: toShellPath(bridgeShPath), timeout: 5, _source: MARKER }],
		});
	}
	await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2) + "\n");
	logger.info(`installed Claude Code hooks → ${settingsPath}`);
}

export async function uninstallHooks(logger: Logger): Promise<void> {
	let settings: Settings = {};
	try {
		settings = JSON.parse(await fs.readFile(settingsPath, "utf8")) as Settings;
	} catch {
		return;
	}
	if (settings.hooks) {
		for (const ev of Object.keys(settings.hooks)) {
			settings.hooks[ev] = settings.hooks[ev]
				.map((entry) => ({
					...entry,
					hooks: (entry.hooks ?? []).filter((h) => h?._source !== MARKER),
				}))
				.filter((entry) => (entry.hooks ?? []).length > 0);
			if (settings.hooks[ev].length === 0) delete settings.hooks[ev];
		}
		if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
	}
	await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2) + "\n");
	for (const p of [bridgeShPath, bridgePyPath]) {
		try {
			await fs.unlink(p);
		} catch {
			/* ignore */
		}
	}
	logger.info("removed Claude Code hooks");
}

function bridgeShell(pyPath: string, pythonCmd: string): string {
	// Capture the controlling tty in shell (Python's os.ttyname only works on a
	// real fd) and hand the rest off to Python for JSON + HTTP.
	return `#!/bin/sh
# Installed by stream-deck-claude-code. Forwards Claude Code hook events to the
# Stream Deck plugin's local server. Fire-and-forget; never blocks Claude.
export STREAMDECK_CC_TTY=\${STREAMDECK_CC_TTY:-$(tty 2>/dev/null || true)}
exec ${shellQuote(pythonCmd)} ${shellQuote(toShellPath(pyPath))}
`;
}

function bridgePython(port: number): string {
	return `#!/usr/bin/env python3
"""stream-deck-claude-code hook bridge.

Reads the Claude Code hook event JSON from stdin, attaches identifying env
(TERM_PROGRAM, ITERM_SESSION_ID, VSCODE_PID, controlling tty), and POSTs it to
the Stream Deck plugin on localhost. Stays silent on any error so it never
blocks Claude.
"""
from __future__ import annotations
import json, os, sys, urllib.request

PORT = ${port}
URL = f"http://127.0.0.1:{PORT}/event"
KEYS = (
    "TERM_PROGRAM",
    "TERM_SESSION_ID",
    "ITERM_SESSION_ID",
    "VSCODE_PID",
    "VSCODE_INJECTION",
    "SSH_TTY",
    "WINDOWID",
    "WT_SESSION",
)


def _win32_host_pid():
    """Windows only. The bridge's own PID (and its immediate shell parent)
    are dead by the time a Stream Deck tile is actually pressed, so PID-based
    focus can't wait until click time to figure out which process to raise.
    Resolve it now: walk the process-ancestor chain and return the first
    ancestor that owns a visible top-level window (this reaches the real
    terminal host — Windows Terminal, cmd, powershell — and, for an
    integrated terminal, the editor hosting it, e.g. Code.exe/Cursor.exe —
    without needing a hardcoded list of terminal executable names). Also
    grab that process's creation-time FILETIME as a validity stamp so the
    focus code can detect PID reuse before trusting this later. Never
    raises; returns None on any failure.
    """
    if sys.platform != "win32":
        return None
    import ctypes
    from ctypes import wintypes

    try:
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        user32 = ctypes.WinDLL("user32", use_last_error=True)

        TH32CS_SNAPPROCESS = 0x00000002
        PROCESS_QUERY_LIMITED_INFORMATION = 0x1000

        class PROCESSENTRY32(ctypes.Structure):
            _fields_ = [
                ("dwSize", wintypes.DWORD),
                ("cntUsage", wintypes.DWORD),
                ("th32ProcessID", wintypes.DWORD),
                ("th32DefaultHeapID", ctypes.POINTER(ctypes.c_ulong)),
                ("th32ModuleID", wintypes.DWORD),
                ("cntThreads", wintypes.DWORD),
                ("th32ParentProcessID", wintypes.DWORD),
                ("pcPriClassBase", ctypes.c_long),
                ("dwFlags", wintypes.DWORD),
                ("szExeFile", ctypes.c_char * 260),
            ]

        snapshot = kernel32.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
        if not snapshot or snapshot == -1:
            return None
        ppid_by_pid = {}
        try:
            entry = PROCESSENTRY32()
            entry.dwSize = ctypes.sizeof(PROCESSENTRY32)
            if kernel32.Process32First(snapshot, ctypes.byref(entry)):
                while True:
                    ppid_by_pid[entry.th32ProcessID] = entry.th32ParentProcessID
                    if not kernel32.Process32Next(snapshot, ctypes.byref(entry)):
                        break
        finally:
            kernel32.CloseHandle(snapshot)

        # Ancestor chain starting at this process, capped so a corrupt/cyclic
        # snapshot can't spin forever.
        chain = []
        pid = os.getpid()
        for _ in range(16):
            chain.append(pid)
            parent = ppid_by_pid.get(pid)
            if not parent or parent == pid:
                break
            pid = parent

        found = {"pid": None}

        def _callback(hwnd, lparam):
            if not user32.IsWindowVisible(hwnd):
                return True
            if user32.GetWindowTextLengthW(hwnd) == 0:
                return True
            owner_pid = wintypes.DWORD()
            user32.GetWindowThreadProcessId(hwnd, ctypes.byref(owner_pid))
            if owner_pid.value == lparam:
                found["pid"] = owner_pid.value
                return False
            return True

        EnumWindowsProc = ctypes.WINFUNCTYPE(
            wintypes.BOOL, wintypes.HWND, wintypes.LPARAM
        )
        cb = EnumWindowsProc(_callback)
        # chain[0] is this console script; it never owns a GUI window itself.
        for ancestor in chain[1:]:
            found["pid"] = None
            user32.EnumWindows(cb, ancestor)
            if found["pid"] is not None:
                break

        if found["pid"] is None:
            return None

        host_pid = found["pid"]
        created_at = None
        handle = kernel32.OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION, False, host_pid
        )
        if handle:
            try:
                creation = wintypes.FILETIME()
                exit_t = wintypes.FILETIME()
                kernel_t = wintypes.FILETIME()
                user_t = wintypes.FILETIME()
                if kernel32.GetProcessTimes(
                    handle,
                    ctypes.byref(creation),
                    ctypes.byref(exit_t),
                    ctypes.byref(kernel_t),
                    ctypes.byref(user_t),
                ):
                    created_at = str(
                        (creation.dwHighDateTime << 32) | creation.dwLowDateTime
                    )
            finally:
                kernel32.CloseHandle(handle)

        return {"hostPid": host_pid, "hostPidCreatedAt": created_at}
    except Exception:
        return None


def main() -> int:
    try:
        body = json.loads(sys.stdin.read() or "{}")
    except Exception:
        body = {}

    env = {k: os.environ[k] for k in KEYS if os.environ.get(k)}
    tty = os.environ.get("STREAMDECK_CC_TTY", "")
    if tty.startswith("/dev/"):
        env["TTY"] = tty
    env["PPID"] = str(os.getppid())
    body["_env"] = env

    win32_host = _win32_host_pid()
    if win32_host:
        body["_win32"] = win32_host

    try:
        req = urllib.request.Request(
            URL,
            data=json.dumps(body).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        urllib.request.urlopen(req, timeout=2).read()
    except Exception:
        pass
    return 0

if __name__ == "__main__":
    sys.exit(main())
`;
}

function shellQuote(s: string): string {
	return "'" + s.replace(/'/g, "'\\''") + "'";
}
