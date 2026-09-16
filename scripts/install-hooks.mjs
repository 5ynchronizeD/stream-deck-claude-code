#!/usr/bin/env node
// Manual installer/uninstaller for the stream-deck-claude-code hook bridge.
// The Setup button on the Stream Deck does the same thing; this is here for
// power users who want to install hooks without Stream Deck running.

import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const PORT = Number(process.env.STREAM_DECK_CC_PORT || 13427);
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

const settingsPath = join(homedir(), ".claude", "settings.json");
const hooksDir = join(homedir(), ".claude", "hooks");
const shPath = join(hooksDir, "stream-deck-bridge.sh");
const pyPath = join(hooksDir, "stream-deck-bridge.py");

const shellQuote = (s) => "'" + s.replace(/'/g, "'\\''") + "'";

// Same reasoning as src/install.ts: Git Bash on Windows eats backslashes as
// escape chars, and `/usr/bin/python3` doesn't exist there either.
const toShellPath = (p) => (process.platform === "win32" ? p.replace(/\\/g, "/") : p);

function resolvePythonPath() {
	if (process.platform !== "win32") return "/usr/bin/python3";
	for (const candidate of ["python3", "python", "py"]) {
		try {
			const out = execFileSync("where", [candidate], { encoding: "utf8" });
			const first = out.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
			if (first) return first;
		} catch {
			/* candidate not on PATH — try the next one */
		}
	}
	return "python";
}

const bridgeShell = (py, pythonCmd) => `#!/bin/sh
# Installed by stream-deck-claude-code.
export STREAMDECK_CC_TTY=\${STREAMDECK_CC_TTY:-$(tty 2>/dev/null || true)}
exec ${shellQuote(pythonCmd)} ${shellQuote(toShellPath(py))}
`;

// Kept in sync with src/install.ts's bridgePython() — both installers must
// produce an equivalent bridge script.
const bridgePython = (port) => `#!/usr/bin/env python3
"""stream-deck-claude-code hook bridge."""
from __future__ import annotations
import json, os, sys, urllib.request

PORT = ${port}
URL = f"http://127.0.0.1:{PORT}/event"
KEYS = ("TERM_PROGRAM","TERM_SESSION_ID","ITERM_SESSION_ID","VSCODE_PID","VSCODE_INJECTION","SSH_TTY","WINDOWID","WT_SESSION")


def _win32_host_pid():
    """Windows only. Resolve the nearest process ancestor that owns a
    visible top-level window (reaches Windows Terminal/cmd/powershell, or
    the editor hosting an integrated terminal, without a hardcoded exe-name
    list), plus its creation-time FILETIME as a PID-reuse validity stamp.
    Never raises; returns None on any failure."""
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

        EnumWindowsProc = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
        cb = EnumWindowsProc(_callback)
        for ancestor in chain[1:]:
            found["pid"] = None
            user32.EnumWindows(cb, ancestor)
            if found["pid"] is not None:
                break

        if found["pid"] is None:
            return None

        host_pid = found["pid"]
        created_at = None
        handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, host_pid)
        if handle:
            try:
                creation = wintypes.FILETIME()
                exit_t = wintypes.FILETIME()
                kernel_t = wintypes.FILETIME()
                user_t = wintypes.FILETIME()
                if kernel32.GetProcessTimes(handle, ctypes.byref(creation), ctypes.byref(exit_t), ctypes.byref(kernel_t), ctypes.byref(user_t)):
                    created_at = str((creation.dwHighDateTime << 32) | creation.dwLowDateTime)
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
    if tty.startswith("/dev/"): env["TTY"] = tty
    env["PPID"] = str(os.getppid())
    body["_env"] = env
    win32_host = _win32_host_pid()
    if win32_host:
        body["_win32"] = win32_host
    try:
        urllib.request.urlopen(urllib.request.Request(URL, data=json.dumps(body).encode(), headers={"Content-Type":"application/json"}, method="POST"), timeout=2).read()
    except Exception:
        pass
    return 0

if __name__ == "__main__":
    sys.exit(main())
`;

async function readSettings() {
	try {
		return JSON.parse(await fs.readFile(settingsPath, "utf8"));
	} catch {
		return {};
	}
}

async function writeSettings(obj) {
	await fs.mkdir(dirname(settingsPath), { recursive: true });
	await fs.writeFile(settingsPath, JSON.stringify(obj, null, 2) + "\n");
}

async function install() {
	await fs.mkdir(hooksDir, { recursive: true });
	const pythonPath = resolvePythonPath();
	await fs.writeFile(pyPath, bridgePython(PORT));
	await fs.chmod(pyPath, 0o755);
	await fs.writeFile(shPath, bridgeShell(pyPath, pythonPath));
	await fs.chmod(shPath, 0o755);

	const settings = await readSettings();
	settings.hooks ??= {};
	for (const ev of EVENTS) {
		const list = (settings.hooks[ev] ??= []);
		const present = list.some(
			(e) => Array.isArray(e?.hooks) && e.hooks.some((h) => h?._source === MARKER),
		);
		if (!present) {
			list.push({ hooks: [{ type: "command", command: toShellPath(shPath), timeout: 5, _source: MARKER }] });
		}
	}
	await writeSettings(settings);
	console.log(`✔ wrote ${shPath}`);
	console.log(`✔ wrote ${pyPath}`);
	console.log(`✔ updated ${settingsPath}`);
	console.log(`hooks will POST to http://127.0.0.1:${PORT}/event`);
}

async function uninstall() {
	const settings = await readSettings();
	if (settings.hooks) {
		for (const ev of Object.keys(settings.hooks)) {
			settings.hooks[ev] = settings.hooks[ev]
				.map((e) => ({
					...e,
					hooks: (e.hooks || []).filter((h) => h?._source !== MARKER),
				}))
				.filter((e) => (e.hooks || []).length > 0);
			if (settings.hooks[ev].length === 0) delete settings.hooks[ev];
		}
		if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
		await writeSettings(settings);
	}
	for (const p of [shPath, pyPath]) {
		try { await fs.unlink(p); } catch {}
	}
	console.log("✔ removed stream-deck-claude-code hooks");
}

const op = process.argv.includes("--uninstall") ? uninstall : install;
op().catch((err) => {
	console.error(err);
	process.exit(1);
});
