import type { Session } from "./state.js";
import { focusSessionMac } from "./focus-mac.js";
import { focusSessionWindows } from "./focus-windows.js";

export async function focusSession(s: Session): Promise<void> {
	if (process.platform === "darwin") return focusSessionMac(s);
	if (process.platform === "win32") return focusSessionWindows(s);
	// No focus implementation for other platforms yet.
}
