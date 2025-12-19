import { Tracer, type LunaUnload } from "@luna/core";
import { MediaItem, PlayState, observe } from "@luna/lib";

export const unloads = new Set<LunaUnload>();

const { trace } = Tracer("[youtubeButton]");

const HEART_SELECTORS = [
	"button[aria-label='Add to favorites']",
	"button[aria-label='Added to favorites']",
	"button[data-test*='favorite']",
	"button[data-test*='heart']",
	"button[title*='favorite']",
	"button[title*='Favorite']",
];

const BUTTON_CLASS = "luna-youtube-button";

observe(unloads, HEART_SELECTORS.join(","), (heart: Element) => {
	const heartButton = asButton(heart);
	if (!heartButton) return;
	insertYoutubeButton(heartButton);
});

const insertYoutubeButton = (heartButton: HTMLButtonElement) => {
	const parent = heartButton.parentElement;
	if (!parent) return;
	if (parent.querySelector(`.${BUTTON_CLASS}`)) return;

	const button = document.createElement("button");
	button.type = "button";
	button.className = BUTTON_CLASS;
	button.title = "현재 곡을 YouTube에서 검색";
	button.style.display = "inline-flex";
	button.style.alignItems = "center";
	button.style.justifyContent = "center";
	const baseWidth = heartButton.offsetWidth || 32;
	const baseHeight = heartButton.offsetHeight || 32;
	const targetSize = Math.max(baseWidth, baseHeight) + 4;
	button.style.width = `${targetSize}px`;
	button.style.height = `${targetSize}px`;
	button.style.marginRight = "6px";
	button.style.borderRadius = heartButton.style.borderRadius || "50%";
	button.style.border = heartButton.style.border || "none";
	button.style.background = heartButton.style.background || "transparent";
	button.style.color = "#ff1f1f";
	button.style.cursor = "pointer";
	button.style.padding = heartButton.style.padding || "0";
	button.style.transition = heartButton.style.transition || "opacity 0.2s ease";
	button.style.opacity = heartButton.style.opacity || "0.9";
	button.innerHTML =
		"<svg viewBox='0 0 24 24' width='20' height='20' aria-hidden='true' focusable='false'>" +
		"<path fill='#ff1f1f' d='M21.8 8.001s-.2-1.4-.8-2c-.8-.9-1.7-.9-2.1-1C15.5 4.8 12 4.8 12 4.8s-3.5 0-6.9.2c-.4.1-1.3.1-2.1 1-.6.6-.8 2-.8 2S2 9.6 2 11.2v1.6c0 1.6.2 3.2.2 3.2s.2 1.4.8 2c.8.9 1.9.8 2.4.9 1.8.2 7.6.2 7.6.2s3.5 0 6.9-.2c.4-.1 1.3-.1 2.1-1 .6-.6.8-2 .8-2s.2-1.6.2-3.2v-1.6c0-1.6-.2-3.2-.2-3.2z'/>" +
		"<path fill='white' d='M10 14.8V8.9l5.2 3-5.2 2.9z'/>" +
		"</svg>";

	const onClick = () => openYoutubeSearch().catch((error: unknown) => logError("openYoutube", error));
	const onEnter = () => {
		button.style.opacity = "1";
	};
	const onLeave = () => {
		button.style.opacity = heartButton.style.opacity || "0.9";
	};
	button.addEventListener("click", onClick);
	button.addEventListener("mouseenter", onEnter);
	button.addEventListener("mouseleave", onLeave);

	parent.insertBefore(button, heartButton);

	const cleanup: LunaUnload = () => {
		button.removeEventListener("click", onClick);
		button.removeEventListener("mouseenter", onEnter);
		button.removeEventListener("mouseleave", onLeave);
		button.remove();
	};
	cleanup.source = "youtubeButton";
	unloads.add(cleanup);
};

const openYoutubeSearch = async () => {
	const query = await buildSearchQuery();
	const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
	window.open(url, "_blank", "noopener,noreferrer");
};

const buildSearchQuery = async () => {
	const media = (await MediaItem.fromPlaybackContext()) ?? undefined;
	if (!media) return "TIDAL";
	const [title, artist] = await Promise.all([
		media.title().catch(() => ""),
		media.artist().then((a) => a?.name ?? "").catch(() => ""),
	]);
	return `${title} ${artist}`.trim() || "TIDAL";
};

const asButton = (elem: Element | null): HTMLButtonElement | null => (elem instanceof HTMLButtonElement ? elem : null);

const logError = (context: string, error: unknown) => {
	const normalizedError = error instanceof Error ? error : new Error(String(error));
	trace.err.withContext(context)(normalizedError);
};
