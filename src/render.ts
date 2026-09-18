import type { Session, SessionState } from "./state.js";
import { STRINGS } from "./strings.js";

type Theme = {
	bg: string;
	band: string;
	captionFg: string;
	captionText: string;
};

const THEMES: Record<SessionState, Theme> = {
	idle:     { bg: "#1c2028", band: "#3a4150", captionFg: "#e6e9f0", captionText: STRINGS.state.idle     },
	thinking: { bg: "#2a1d0d", band: "#e89726", captionFg: "#ffffff", captionText: STRINGS.state.thinking },
	working:  { bg: "#0f1a2e", band: "#2f6bd6", captionFg: "#ffffff", captionText: STRINGS.state.working  },
	waiting:  { bg: "#2a0d16", band: "#d63a52", captionFg: "#ffffff", captionText: STRINGS.state.waiting  },
	done:     { bg: "#0f2a1a", band: "#2fa056", captionFg: "#ffffff", captionText: STRINGS.state.done     },
	error:    { bg: "#2a0d0d", band: "#cc3030", captionFg: "#ffffff", captionText: STRINGS.state.error    },
};

const EMPTY: Theme = {
	bg: "#0a0c10", band: "#1a1d24", captionFg: "#6a7184", captionText: STRINGS.empty.noSession,
};

const FONT_STACK = "-apple-system, BlinkMacSystemFont, SFProText-Regular, Helvetica, Arial, sans-serif";

const NAME_TOP = 6;
const BAND_HEIGHT = 48;
const BAND_TOP = 144 - BAND_HEIGHT;
const CAPTION_FONT = 26;
const CAPTION_BASELINE = BAND_TOP + Math.floor((BAND_HEIGHT + CAPTION_FONT * 0.7) / 2);
const TILE_MAX_TEXT_WIDTH = 132;
const NAME_WEIGHT = 700;
const SUBTITLE_BASELINE = 82;
const SUBTITLE_FONT = 24;
const SUBTITLE_WEIGHT = 300;
const SUBTITLE_COLOR = "#cdd2dc";

// Animation tick period (ms). Smaller = smoother but more RPC traffic.
export const ANIM_TICK_MS = 50;

function esc(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function svgWrap(inner: string): string {
	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 144 144">${inner}</svg>`;
}

function svgToDataUri(svg: string): string {
	return "data:image/svg+xml;base64," + Buffer.from(svg, "utf8").toString("base64");
}

function hexToRgb(hex: string): [number, number, number] {
	const h = hex.replace("#", "");
	return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
function rgbToHex(r: number, g: number, b: number): string {
	const c = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");
	return "#" + c(r) + c(g) + c(b);
}
function dim(hex: string, factor: number): string {
	if (factor >= 0.999) return hex;
	const [r, g, b] = hexToRgb(hex);
	return rgbToHex(r * factor, g * factor, b * factor);
}

function estimateWidthPx(text: string, fontSize: number): number {
	return text.length * fontSize * 0.62;
}

function textLine(label: string, y: number, fontSize: number): string {
	const overflow = estimateWidthPx(label, fontSize) > TILE_MAX_TEXT_WIDTH;
	const fit = overflow ? ` textLength="${TILE_MAX_TEXT_WIDTH}" lengthAdjust="spacingAndGlyphs"` : "";
	return `<text x="72" y="${y}" text-anchor="middle" font-family="${FONT_STACK}"
	             font-size="${fontSize}" font-weight="${NAME_WEIGHT}" fill="#ffffff"${fit}>${esc(label)}</text>`;
}

function pickSingleLineSize(label: string): number | null {
	const n = label.length;
	if (n <= 5) return 36;
	if (n <= 7) return 30;
	if (n <= 9) return 26;
	if (n <= 11) return 22;
	if (n <= 13) return 18;
	return null;
}

function pickTwoLineSize(longest: number): number {
	if (longest <= 8) return 22;
	if (longest <= 10) return 20;
	if (longest <= 12) return 18;
	if (longest <= 14) return 16;
	return 14;
}

/** Try to split the label on a natural separator near the middle. Returns
 *  null if no `-/_./ ` separator is within reach — for label without
 *  separators we'd rather render small than break a word in two. */
function trySplitOnSeparator(label: string): { top: string; bot: string } | null {
	const ideal = Math.floor(label.length / 2);
	for (let r = 0; r <= 6; r++) {
		for (const probe of [ideal - r, ideal + r]) {
			if (probe <= 0 || probe >= label.length) continue;
			if (/[-_./ ]/.test(label[probe])) {
				const cut = probe + 1;
				return { top: label.slice(0, cut), bot: label.slice(cut) };
			}
		}
	}
	return null;
}

/** True if the subtitle (the full `aiTitle`) is too wide for one line at
 *  `SUBTITLE_FONT`, so `paintSubtitle` will scroll it instead of cutting it
 *  short with `…`. Used by the animation loop the same way `nameWillScroll`
 *  and `captionWillScroll` are. */
export function subtitleWillScroll(text: string | undefined): boolean {
	if (!text) return false;
	return estimateWidthPx(text, SUBTITLE_FONT) > TILE_MAX_TEXT_WIDTH;
}

const SUBTITLE_SCROLL_PX_PER_TICK = 2;
const SUBTITLE_LOOP_GAP = 32;

function marqueeSubtitle(text: string, phase: number): string {
	const width = estimateWidthPx(text, SUBTITLE_FONT);
	const period = width + SUBTITLE_LOOP_GAP;
	const offset = (phase * SUBTITLE_SCROLL_PX_PER_TICK) % period;
	const clipId = `sl_${SUBTITLE_BASELINE}`;
	const y0 = SUBTITLE_BASELINE - SUBTITLE_FONT;
	return `
		<defs>
			<clipPath id="${clipId}">
				<rect x="0" y="${y0}" width="144" height="${Math.round(SUBTITLE_FONT * 1.3)}"/>
			</clipPath>
		</defs>
		<g clip-path="url(#${clipId})">
			<text x="${-offset + 8}" y="${SUBTITLE_BASELINE}" text-anchor="start"
			      font-family="${FONT_STACK}" font-size="${SUBTITLE_FONT}" font-weight="${SUBTITLE_WEIGHT}"
			      fill="${SUBTITLE_COLOR}" opacity="0.95">${esc(text)}</text>
			<text x="${-offset + 8 + period}" y="${SUBTITLE_BASELINE}" text-anchor="start"
			      font-family="${FONT_STACK}" font-size="${SUBTITLE_FONT}" font-weight="${SUBTITLE_WEIGHT}"
			      fill="${SUBTITLE_COLOR}" opacity="0.95">${esc(text)}</text>
		</g>
	`;
}

function paintSubtitle(text: string | undefined, phase: number): string {
	if (!text) return "";
	if (subtitleWillScroll(text)) return marqueeSubtitle(text, phase);
	return `<text x="72" y="${SUBTITLE_BASELINE}" text-anchor="middle" font-family="${FONT_STACK}"
	             font-size="${SUBTITLE_FONT}" font-weight="${SUBTITLE_WEIGHT}"
	             fill="${SUBTITLE_COLOR}" opacity="0.95">${esc(text)}</text>`;
}

/** True if the name doesn't fit as a clean single line or a two-line wrap on
 *  a natural separator, so `paintName` will scroll it instead of squeezing
 *  letters together or forcing a mid-word break. Used by the animation loop
 *  to bypass the brightness-only dedup — without this, scroll position
 *  freezes during brightness plateaus (same reason `captionWillScroll`
 *  exists). */
export function nameWillScroll(label: string): boolean {
	const single = pickSingleLineSize(label);
	const split = trySplitOnSeparator(label);
	const wrapSize = split ? pickTwoLineSize(Math.max(split.top.length, split.bot.length)) : null;
	if (split !== null && wrapSize !== null && (single === null || wrapSize > single)) return false;
	if (single !== null && estimateWidthPx(label, single) <= TILE_MAX_TEXT_WIDTH) return false;
	return true;
}

// Marquee scroll for the name, same mechanics as the caption's (see
// paintBand): pixels moved per animation tick, gap between repeated copies.
const NAME_SCROLL_PX_PER_TICK = 2;
const NAME_LOOP_GAP = 32;
const NAME_FONT = 26;
const NAME_CLIP_HEIGHT = 40;

function marqueeName(label: string, phase: number): string {
	const baseline = NAME_TOP + Math.round(NAME_FONT * 0.82);
	const width = estimateWidthPx(label, NAME_FONT);
	const period = width + NAME_LOOP_GAP;
	const offset = (phase * NAME_SCROLL_PX_PER_TICK) % period;
	const clipId = `nm_${NAME_TOP}`;
	return `
		<defs>
			<clipPath id="${clipId}">
				<rect x="0" y="0" width="144" height="${NAME_CLIP_HEIGHT}"/>
			</clipPath>
		</defs>
		<g clip-path="url(#${clipId})">
			<text x="${-offset + 8}" y="${baseline}" text-anchor="start"
			      font-family="${FONT_STACK}" font-size="${NAME_FONT}" font-weight="${NAME_WEIGHT}"
			      fill="#ffffff">${esc(label)}</text>
			<text x="${-offset + 8 + period}" y="${baseline}" text-anchor="start"
			      font-family="${FONT_STACK}" font-size="${NAME_FONT}" font-weight="${NAME_WEIGHT}"
			      fill="#ffffff">${esc(label)}</text>
		</g>
	`;
}

function paintName(label: string, phase: number): string {
	const single = pickSingleLineSize(label);
	const split = trySplitOnSeparator(label);
	const wrapSize = split ? pickTwoLineSize(Math.max(split.top.length, split.bot.length)) : null;

	// Prefer whichever rendering uses the LARGER font. A 13-char label with
	// a hyphen near the middle (e.g. `alpha-service`) would single-line at
	// 18pt, but split as `alpha-` / `service` at 22pt — wrap is bigger.
	if (split !== null && wrapSize !== null && (single === null || wrapSize > single)) {
		return renderWrapped(split.top, split.bot, wrapSize);
	}
	if (single !== null && estimateWidthPx(label, single) <= TILE_MAX_TEXT_WIDTH) {
		const baseline = NAME_TOP + Math.round(single * 0.82);
		return textLine(label, baseline, single);
	}
	// Doesn't fit on one line at a readable size, and no clean separator to
	// wrap on — scroll it so the whole name is still readable, instead of
	// squeezing letters together (textLength) or forcing a mid-word break.
	return marqueeName(label, phase);
}

function renderWrapped(top: string, bot: string, size: number): string {
	const gap = 2;
	const y1 = NAME_TOP + Math.round(size * 0.82);
	const y2 = y1 + size + gap;
	return `${textLine(top, y1, size)}\n${textLine(bot, y2, size)}`;
}

// Approximate width of the caption text at CAPTION_FONT weight 700. Used to
// decide whether to scroll.
const CAPTION_CHAR_WIDTH = CAPTION_FONT * 0.55;
const CAPTION_MAX_STATIC_WIDTH = 132;

/** True if the band caption for this session would overflow and thus scroll.
 *  Used by the animation loop to bypass the brightness-only dedup — without
 *  this, scroll position freezes during brightness plateaus. Marquee only
 *  applies to long tool names in the `working` state; other overflows get
 *  squeezed via textLength instead. */
export function captionWillScroll(session: Session): boolean {
	if (session.state !== "working") return false;
	const tool = session.lastTool;
	if (!tool) return false;
	return tool.length * CAPTION_CHAR_WIDTH > CAPTION_MAX_STATIC_WIDTH;
}

/** "1m", "59m", "1h", "23h", "1d", "99d". Never exceeds 3 chars. */
export function compactDuration(ms: number): string {
	const minutes = Math.floor(ms / 60_000);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h`;
	const days = Math.floor(hours / 24);
	if (days < 100) return `${days}d`;
	return "99d";
}

/** After this much idle time in `done` state, append `(Xy)` to the caption
 *  so the user can tell how long a session has been waiting on them. */
const DONE_HINT_AFTER_MS = 10 * 60 * 1000;
/** Idle-time hint stays at the SAME font size as the caption — only the
 *  weight is lighter. Iron rule: "lighter" means weight, never size. */
const HINT_WEIGHT = 300;

function idleHint(session: Session, now: number): string | undefined {
	if (session.state !== "done") return undefined;
	const age = now - session.lastUpdate;
	if (age < DONE_HINT_AFTER_MS) return undefined;
	return `- ${compactDuration(age)}`;
}
// Marquee scroll: pixels moved per animation tick. At 50ms ticks (20fps),
// 2px/tick = 40px/sec — comfortable reading speed for the band caption.
const CAPTION_SCROLL_PX_PER_TICK = 2;
// Gap between repeated copies of the caption in the marquee.
const CAPTION_LOOP_GAP = 32;

function paintBand(caption: string, hint: string | undefined, bandColor: string, captionFg: string, phase: number, allowMarquee: boolean): string {
	const bandRect = `<rect x="0" y="${BAND_TOP}" width="144" height="${BAND_HEIGHT}" fill="${bandColor}"/>`;
	// Bold main + (optional) lighter, slightly smaller hint sharing a baseline.
	// Approximate widths so we know whether to squeeze.
	const mainWidth = caption.length * CAPTION_CHAR_WIDTH;
	const hintWidth = hint ? (hint.length + 1) * CAPTION_FONT * 0.45 : 0; // light weight at same size
	const naturalWidth = mainWidth + hintWidth;
	const hintSpan = hint
		? ` <tspan font-weight="${HINT_WEIGHT}">${esc(hint)}</tspan>`
		: "";

	if (naturalWidth <= CAPTION_MAX_STATIC_WIDTH) {
		return `
			${bandRect}
			<text x="72" y="${CAPTION_BASELINE}" text-anchor="middle" font-family="${FONT_STACK}"
			      font-size="${CAPTION_FONT}" font-weight="700" fill="${captionFg}">${esc(caption)}${hintSpan}</text>
		`;
	}

	if (!allowMarquee) {
		// Overflow but no scroll allowed — squeeze with textLength so it
		// stays centered without clipping past the sides.
		return `
			${bandRect}
			<text x="72" y="${CAPTION_BASELINE}" text-anchor="middle" font-family="${FONT_STACK}"
			      font-size="${CAPTION_FONT}" font-weight="700" fill="${captionFg}"
			      textLength="${CAPTION_MAX_STATIC_WIDTH}" lengthAdjust="spacingAndGlyphs">${esc(caption)}${hintSpan}</text>
		`;
	}

	// Marquee: render the text twice (with a gap) inside a clip rect, shift
	// left over time, wrap around when one copy scrolls off-screen.
	const period = naturalWidth + CAPTION_LOOP_GAP;
	const offset = (phase * CAPTION_SCROLL_PX_PER_TICK) % period;
	const clipId = `bc_${BAND_TOP}`;
	return `
		${bandRect}
		<defs>
			<clipPath id="${clipId}">
				<rect x="0" y="${BAND_TOP}" width="144" height="${BAND_HEIGHT}"/>
			</clipPath>
		</defs>
		<g clip-path="url(#${clipId})">
			<text x="${-offset + 8}" y="${CAPTION_BASELINE}" text-anchor="start"
			      font-family="${FONT_STACK}" font-size="${CAPTION_FONT}" font-weight="700"
			      fill="${captionFg}">${esc(caption)}</text>
			<text x="${-offset + 8 + period}" y="${CAPTION_BASELINE}" text-anchor="start"
			      font-family="${FONT_STACK}" font-size="${CAPTION_FONT}" font-weight="700"
			      fill="${captionFg}">${esc(caption)}</text>
		</g>
	`;
}

export function shouldAnimate(state: SessionState): boolean {
	return state === "thinking" || state === "working" || state === "waiting";
}

/** Brightness for the colored band, given the current animation tick. Smooth
 *  cosine breath; minimum dimness differs per state so waiting is more
 *  attention-grabbing than thinking/working. */
export function brightnessFor(state: SessionState, phase: number): number {
	if (!shouldAnimate(state)) return 1;
	const isWaiting = state === "waiting";
	const cycleMs = isWaiting ? 900 : 1900;
	const t = ((phase * ANIM_TICK_MS) % cycleMs) / cycleMs;
	const wave = 0.5 + 0.5 * Math.cos(t * Math.PI * 2);
	const min = isWaiting ? 0.40 : 0.62;
	return min + (1 - min) * wave;
}

export function renderEmpty(hooksMissing = false): string {
	const t = EMPTY;
	const caption = hooksMissing ? STRINGS.empty.setupNeeded : STRINGS.empty.noSession;
	const center = hooksMissing
		? `<text x="72" y="48" text-anchor="middle" font-family="${FONT_STACK}"
		         font-size="18" font-weight="700" fill="#8a8f99">${esc(STRINGS.empty.setupHintTop)}</text>
		   <text x="72" y="72" text-anchor="middle" font-family="${FONT_STACK}"
		         font-size="14" font-weight="500" fill="#5a6070">${esc(STRINGS.empty.setupHintBottom)}</text>`
		: "";
	return svgToDataUri(svgWrap(`
		<rect width="144" height="144" rx="12" fill="${t.bg}"/>
		${center}
		${paintBand(caption, undefined, t.band, t.captionFg, 0, false)}
	`));
}

/** The subtitle for a session: Claude's auto-generated title for what it's
 *  doing, shown verbatim (not reduced to a single keyword — the user wants
 *  to actually read it, not guess at it). Exported so the animation loop can
 *  check `subtitleWillScroll` on the same value `renderSession` paints. */
export function subtitleFor(session: Session): string {
	return session.aiTitle ?? "";
}

export function renderSession(session: Session, phase = 0, now = Date.now()): { image: string; title: string } {
	const t = THEMES[session.state] ?? THEMES.idle;
	const caption =
		session.state === "working" && session.lastTool
			? session.lastTool.toLowerCase()
			: t.captionText;
	const hint = idleHint(session, now);
	const brightness = brightnessFor(session.state, phase);
	const bandColor = dim(t.band, brightness);
	const captionFg = brightness < 0.7 ? dim(t.captionFg, 0.55 + brightness * 0.45) : t.captionFg;
	const subtitle = subtitleFor(session);
	// Marquee is reserved for `working` with a long tool name. Other overflow
	// (e.g. `ready (12m)`) gets squeezed instead so static text doesn't scroll.
	const allowMarquee = session.state === "working";
	const inner = `
		<rect width="144" height="144" rx="12" fill="${t.bg}"/>
		${paintName(session.label, phase)}
		${paintSubtitle(subtitle, phase)}
		${paintBand(caption, hint, bandColor, captionFg, phase, allowMarquee)}
	`;
	return { image: svgToDataUri(svgWrap(inner)), title: "" };
}
