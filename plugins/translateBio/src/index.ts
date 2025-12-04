import { Tracer, type LunaUnload } from "@luna/core";
import { observe } from "@luna/lib";

export const unloads = new Set<LunaUnload>();

const { trace } = Tracer("[translateBio]");

const BIO_CONTAINER_SELECTOR = [
	"[class^='_artistBio_']",
	"[class*='artistBio']",
	"[data-test='credits'] [class^='_artistBio_']",
	"section[data-test*='bio'] [class^='_artistBio_']",
].join(",");

const BUTTON_CLASS = "luna-translate-bio-button";
const BUTTON_DEFAULT_TEXT = "번역";
const BUTTON_LOADING_TEXT = "번역중...";
const BUTTON_SUCCESS_TEXT = "번역됨";
const BUTTON_FAIL_TEXT = "실패";
const BUTTON_LABELS = {
	original: BUTTON_DEFAULT_TEXT,
	translated: "원문",
} as const;
type ButtonMode = keyof typeof BUTTON_LABELS;
observe(unloads, BIO_CONTAINER_SELECTOR, (element: Element) => {
	const container = asHTMLElement(element);
	if (!container) return;
	enhanceBioSection(container);
});

const enhanceBioSection = (container: HTMLElement) => {
	if (container.dataset.lunaTranslateAttached === "true") return;
	const label = findBioLabel(container);
	if (!label) {
		trace.warn("[translateBio] Bio 라벨을 찾지 못했습니다.");
		return;
	}
	const contentWrapper = ensureContentWrapper(container, label);
	if (!contentWrapper) return;
	const button = document.createElement("button");
	button.type = "button";
	button.title = "Bio를 한국어로 번역합니다";
	button.className = BUTTON_CLASS;
	button.style.marginLeft = "8px";
	button.style.padding = "2px 10px";
	button.style.fontSize = "12px";
	button.style.borderRadius = "999px";
	button.style.border = "1px solid currentColor";
	button.style.background = "transparent";
	button.style.color = "inherit";
	button.style.cursor = "pointer";
	button.style.opacity = "0.85";
	button.style.transition = "opacity 0.2s ease";

	const onEnter = () => {
		button.style.opacity = "1";
	};
	const onLeave = () => {
		button.style.opacity = "0.85";
	};
	setButtonState(button, "idle", "original");
	const onClick = () => handleButtonClick(container, button).catch((error: unknown) => logError("toggleTranslateBio", error));
	button.addEventListener("mouseenter", onEnter);
	button.addEventListener("mouseleave", onLeave);
	button.addEventListener("click", onClick);

	label.insertAdjacentElement("afterend", button);
	container.dataset.lunaTranslateAttached = "true";

	const cleanup: LunaUnload = () => {
		button.removeEventListener("mouseenter", onEnter);
		button.removeEventListener("mouseleave", onLeave);
		button.removeEventListener("click", onClick);
		button.remove();
		container.dataset.lunaTranslateAttached = "false";
	};
	tokenizeCleanupSource(cleanup, "translateBio/button");
	unloads.add(cleanup);
};

const handleButtonClick = async (container: HTMLElement, button: HTMLButtonElement) => {
	const contentWrapper = resolveBioContainer(container);
	if (!contentWrapper) {
		trace.warn("[translateBio] Bio 콘텐츠 영역을 찾지 못했습니다.");
		setButtonState(button, "error", "original");
		return;
	}

	const isTranslated = contentWrapper.dataset.lunaTranslated === "true";
	if (isTranslated) {
		restoreOriginalBio(contentWrapper);
		setButtonState(button, "idle", "original");
		return;
	}

	const cachedTranslation = contentWrapper.dataset.lunaTranslatedBioHtml;
	if (cachedTranslation) {
		contentWrapper.innerHTML = cachedTranslation;
		contentWrapper.dataset.lunaTranslated = "true";
		setButtonState(button, "idle", "translated");
		return;
	}

	await translateBio(contentWrapper, button);
};

const translateBio = async (wrapper: HTMLElement, button: HTMLButtonElement) => {
	if (button.dataset.translating === "true") return;
	setButtonState(button, "loading", "original");

	const paragraphs = getOriginalParagraphs(wrapper);
	if (paragraphs.length === 0) {
		trace.warn("[translateBio] 번역할 문단이 없습니다.");
		setButtonState(button, "error", "original");
		return;
	}

	try {
		const translatedParagraphs = await translateParagraphs(paragraphs);
		if (translatedParagraphs.length !== paragraphs.length) throw new Error("문단 수가 일치하지 않습니다.");
		const translatedHtml = renderParagraphHtml(translatedParagraphs);
		wrapper.innerHTML = translatedHtml;
		wrapper.dataset.lunaTranslated = "true";
		wrapper.dataset.lunaTranslatedBioHtml = translatedHtml;
		trace.log(`[translateBio] 번역 완료 (${paragraphs.length}개 문단)`);
		setButtonState(button, "success", "translated");
	} catch (error) {
		logError("translateBio", error);
		setButtonState(button, "error", "original");
	}
};

type ButtonState = "idle" | "loading" | "success" | "error";

const setButtonState = (button: HTMLButtonElement, state: ButtonState, mode: ButtonMode) => {
	button.dataset.translating = state === "loading" ? "true" : "false";
	button.dataset.translationMode = mode;
	switch (state) {
		case "idle":
			button.disabled = false;
			button.textContent = BUTTON_LABELS[mode];
			break;
		case "loading":
			button.disabled = true;
			button.textContent = BUTTON_LOADING_TEXT;
			break;
		case "success":
			button.disabled = false;
			button.textContent = BUTTON_SUCCESS_TEXT;
			setTimeout(() => {
				if (!button.isConnected) return;
				setButtonState(button, "idle", mode);
			}, 1200);
			break;
		case "error":
			button.disabled = false;
			button.textContent = BUTTON_FAIL_TEXT;
			setTimeout(() => {
				if (!button.isConnected) return;
				setButtonState(button, "idle", mode);
			}, 2000);
			break;
	}
};

const fetchKoreanTranslation = async (text: string) => {
	const params = new URLSearchParams({
		client: "gtx",
		sl: "auto",
		tl: "ko",
		dt: "t",
		q: text,
	});

	const response = await fetch("https://translate.googleapis.com/translate_a/single", {
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
		},
		body: params.toString(),
	});

	if (!response.ok) throw new Error(`Google Translate 요청 실패: ${response.status}`);
	const data = (await response.json()) as unknown;
	return extractTranslatedText(data);
};

const extractTranslatedText = (payload: unknown): string | null => {
	if (!Array.isArray(payload)) return null;
	const segments = payload[0];
	if (!Array.isArray(segments)) return null;
	return segments
		.map((segment) => (Array.isArray(segment) && typeof segment[0] === "string" ? segment[0] : ""))
		.join("")
		.trim();
};


const resolveBioContainer = (container: HTMLElement): HTMLElement | null => findContentWrapper(container) ?? null;


const ensureContentWrapper = (container: HTMLElement, label: HTMLElement) => {
	const existing = findContentWrapper(container);
	if (existing) {
		cacheOriginalState(existing);
		return existing;
	}
	const wrapper = document.createElement("div");
	wrapper.dataset.lunaBioContent = "true";
	wrapper.style.marginTop = "8px";
	container.appendChild(wrapper);
	const nodesToMove = Array.from(container.childNodes).filter((node) => {
		if (node === label || node === wrapper) return false;
		if (node instanceof HTMLElement && node.classList.contains(BUTTON_CLASS)) return false;
		return !isWhitespaceNode(node);
	});
	for (const node of nodesToMove) wrapper.appendChild(node);
	cacheOriginalState(wrapper);
	return wrapper;
};

const findContentWrapper = (container: HTMLElement) => container.querySelector<HTMLElement>("[data-luna-bio-content='true']");

const findBioLabel = (container: HTMLElement) => {
	const directChild = Array.from(container.children).find(
		(child): child is HTMLElement => child instanceof HTMLElement && isBioLabel(child),
	);
	if (directChild) return directChild;
	const fallbacks = container.querySelectorAll<HTMLElement>("span, h2, h3, h4, h5, h6");
	for (const element of fallbacks) {
		if (element.closest("[class^='_artistBio_']") !== container) continue;
		if (isBioLabel(element)) return element;
	}
	return null;
};

const cacheOriginalState = (wrapper: HTMLElement) => {
	if (!wrapper.dataset.lunaOriginalBioHtml) wrapper.dataset.lunaOriginalBioHtml = wrapper.innerHTML;
	if (!wrapper.dataset.lunaOriginalBioParagraphs) {
		const paragraphs = extractParagraphsFromText(wrapper.innerText);
		wrapper.dataset.lunaOriginalBioParagraphs = JSON.stringify(paragraphs);
	}
};

const restoreOriginalBio = (wrapper: HTMLElement) => {
	const originalHtml = wrapper.dataset.lunaOriginalBioHtml;
	if (typeof originalHtml === "string") wrapper.innerHTML = originalHtml;
	wrapper.dataset.lunaTranslated = "false";
};

const getOriginalParagraphs = (wrapper: HTMLElement) => {
	const cached = wrapper.dataset.lunaOriginalBioParagraphs;
	if (cached) {
		try {
			const parsed = JSON.parse(cached) as string[];
			if (parsed.length > 0) return parsed;
		} catch (error) {
			logError("parseOriginalParagraphs", error);
		}
	}
	const html = wrapper.dataset.lunaOriginalBioHtml ?? wrapper.innerHTML;
	const temp = document.createElement("div");
	temp.innerHTML = html;
	const paragraphs = extractParagraphsFromText(temp.innerText);
	wrapper.dataset.lunaOriginalBioParagraphs = JSON.stringify(paragraphs);
	return paragraphs;
};

const extractParagraphsFromText = (rawText: string) => {
	const normalized = rawText.replace(/\r/g, "");
	const segments = normalized
		.split(/\n{2,}/)
		.map((segment) => normalizeText(segment))
		.filter((segment) => segment.length > 0);
	return segments.length > 0 ? segments : [normalizeText(normalized)];
};

const translateParagraphs = (paragraphs: string[]) =>
	Promise.all(
		paragraphs.map(async (paragraph) => {
			const translated = await fetchKoreanTranslation(paragraph);
			if (!translated) throw new Error("번역 결과가 비어 있습니다.");
			return translated;
		}),
	);

const renderParagraphHtml = (paragraphs: string[]) => {
	const fragment = document.createElement("div");
	for (const text of paragraphs) {
		const p = document.createElement("p");
		p.textContent = text;
		fragment.appendChild(p);
	}
	return fragment.innerHTML;
};

const asHTMLElement = (elem: Element | null): HTMLElement | null => (elem instanceof HTMLElement ? elem : null);

const isWhitespaceNode = (node: Node) => node.nodeType === Node.TEXT_NODE && !(node.textContent ?? "").trim();

const isBioLabel = (heading: HTMLElement) => normalizeText(heading.textContent ?? "").toLowerCase().includes("bio");

const normalizeText = (text: string) => text.replace(/\s+/g, " ").trim();

const tokenizeCleanupSource = (cleanup: LunaUnload, source: string) => {
	cleanup.source = source;
};

const logError = (context: string, error: unknown) => {
	const normalizedError = error instanceof Error ? error : new Error(String(error));
	trace.err.withContext(context)(normalizedError);
};
