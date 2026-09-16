import { spawn } from "node:child_process";
import { basename } from "node:path";
import type { Session } from "./state.js";

type Result = { ok: boolean; out: string };

function powershell(script: string): Promise<Result> {
	return new Promise((resolve) => {
		const p = spawn("powershell", ["-NoProfile", "-NonInteractive", "-Command", script]);
		let out = "";
		p.stdout.on("data", (d) => (out += d.toString()));
		p.on("close", (code) => resolve({ ok: code === 0, out: out.trim() }));
		p.on("error", () => resolve({ ok: false, out: "" }));
	});
}

/** Escape a value for interpolation into a single-quoted PowerShell string
 *  literal — only the quote character itself needs doubling. */
function psEsc(s: string): string {
	return s.replace(/'/g, "''");
}

function openInExplorer(path: string): Promise<void> {
	return new Promise((resolve) => {
		const p = spawn("explorer.exe", [path], { stdio: "ignore" });
		p.on("close", () => resolve());
		p.on("error", () => resolve());
	});
}

/** Bring the window owned by the bridge-resolved host PID to the front.
 *  `resolvedHostPid` was found by the Python bridge at *hook* time by
 *  walking the process-ancestor chain to the first ancestor that owns a
 *  visible top-level window — name-agnostic, so it reaches Windows
 *  Terminal/cmd/powershell *and* the editor hosting an integrated terminal
 *  (VS Code/Cursor) with the same code path.
 *
 *  By the time a tile is actually pressed, that PID may have been recycled
 *  by Windows (the bridge's own short-lived process is long dead), so we
 *  revalidate it first: .NET's `Process.StartTime.ToFileTime()` is
 *  byte-identical to the Win32 FILETIME the bridge captured via
 *  `GetProcessTimes`, so an exact string match proves it's still the same
 *  process instance before we trust it.
 *
 *  `AppActivate` (the `WScript.Shell` COM object) is used instead of a
 *  `user32.dll` P/Invoke `SetForegroundWindow` call for two reasons: (1) it
 *  internally handles the Windows foreground-lock restriction that makes
 *  `SetForegroundWindow` silently no-op when called from a background
 *  process — the caller would otherwise need the `AttachThreadInput` dance
 *  itself; (2) it avoids `Add-Type` compiling a P/Invoke signature on every
 *  keypress, which is slow (shells out to the C# compiler) and can be
 *  blocked outright by Constrained Language Mode in locked-down
 *  environments. */
async function focusByResolvedHostPid(pid: number, createdAt: string | undefined): Promise<boolean> {
	const checkCreatedAt = createdAt
		? `if ($target.StartTime.ToFileTime().ToString() -ne '${psEsc(createdAt)}') { exit 1 }`
		: "";
	const script = `
		try {
			$target = Get-Process -Id ${pid} -ErrorAction Stop
			${checkCreatedAt}
			(New-Object -ComObject WScript.Shell).AppActivate(${pid}) | Out-Null
			exit 0
		} catch {
			exit 1
		}
	`;
	const r = await powershell(script);
	return r.ok;
}

/** Fallback for when the bridge couldn't resolve a host PID at all (older
 *  Claude Code build without the hook data, or the ancestry walk found no
 *  ancestor owning a GUI window): raise a VS Code/Cursor window whose title
 *  contains the project folder name. Same granularity limit as the macOS
 *  VS Code fallback in focus-mac.ts — this can only raise the whole app
 *  window, not address a specific integrated-terminal pane. */
async function focusVSCodeByTitle(cwd: string): Promise<boolean> {
	const project = psEsc(basename(cwd));
	if (!project) return false;
	const script = `
		try {
			$procs = Get-Process -Name 'Code','Code - Insiders','Cursor' -ErrorAction SilentlyContinue
			foreach ($p in $procs) {
				if ($p.MainWindowTitle -like "*${project}*") {
					(New-Object -ComObject WScript.Shell).AppActivate($p.Id) | Out-Null
					exit 0
				}
			}
			exit 1
		} catch {
			exit 1
		}
	`;
	const r = await powershell(script);
	return r.ok;
}

export async function focusSessionWindows(s: Session): Promise<void> {
	const pid = s.terminal.resolvedHostPid;
	if (pid && (await focusByResolvedHostPid(pid, s.terminal.resolvedHostPidCreatedAt))) return;

	if (await focusVSCodeByTitle(s.cwd)) return;

	if (s.cwd) await openInExplorer(s.cwd);
}
