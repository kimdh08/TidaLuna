import { Tracer, type LunaUnload } from "@luna/core";
import { MediaItem, PlayState, getPlaybackInfo, ipcRenderer } from "@luna/lib";
import { startCommandServer, stopCommandServer, type RemoteCommand } from "./server.native";
import { type TrackStatusPayload, type TrackUpdatePayload } from "./types";

export const unloads = new Set<LunaUnload>();

const { trace } = Tracer("[playingInfo]");

const commandChannel = "__luna/playnowinfo/command";
const trackInfoChannel = "__luna/playnowinfo/trackInfo";

startCommandServer().catch((error) => logError("startCommandServer", error));
const commandServerUnload: LunaUnload = () => {
	stopCommandServer().catch((error) => logError("stopCommandServer", error));
};
commandServerUnload.source = "commandServer";
unloads.add(commandServerUnload);

ipcRenderer.on(unloads, commandChannel, (command: RemoteCommand) => {
	handleRemoteCommand(command);
});

let latestTrackInfo: TrackStatusPayload | undefined;

let activeMediaItem: MediaItem | undefined;
let activeDurationSeconds = 0;

const logTrackDetails = async (mediaItem: MediaItem) => {
	activeMediaItem = mediaItem;
	const playbackContext = PlayState.playbackContext;
	const chosenQuality = playbackContext?.actualAudioQuality ?? mediaItem.bestQuality.audioQuality;

	try {
		const [title, albumTitle, artistName, coverUrl, playbackInfo, releaseDate, isrc] = await Promise.all([
			mediaItem.title(),
			mediaItem.album().then((album) => album?.title()),
			mediaItem
				.artist()
				.then((artist) => artist?.name),
			mediaItem.coverUrl({ res: "640" }),
			getPlaybackInfo(mediaItem.id, chosenQuality),
			mediaItem.releaseDate(),
			mediaItem.isrc(),
		]);

			activeDurationSeconds = playbackContext?.actualDuration ?? mediaItem.duration ?? 0;
			const releaseDateStr = releaseDate?.toISOString().slice(0, 10) ?? "Unknown";
			const popularity = mediaItem.tidalItem.popularity ?? "Unknown";
			const trackPayload: TrackUpdatePayload = {
				album: albumTitle ?? "",
				artist: artistName ?? "",
				audioquality: playbackInfo.audioQuality,
				duration: String(activeDurationSeconds || 0),
				imgurl: extractCoverResourceId(coverUrl),
				isrc: isrc ?? "",
				popularity: String(popularity),
				releasedate: releaseDateStr,
				title,
				trackid: String(mediaItem.id),
			};
			const status = resolvePlaybackControls()?.playbackState ?? "UNKNOWN";
			const positionSeconds = getCurrentPositionSeconds();
			publishTrackInfo({ ...trackPayload, status, positionSeconds, positionUpdatedAt: Date.now() });
		if (coverUrl) trace.log(`[Artwork] ${title} - ${coverUrl}`);
	} catch (error) {
		logError("logTrackDetails", error);
	}
};

PlayState.onState(unloads, (state) => {
	const positionSeconds = getCurrentPositionSeconds();
	updateTrackInfoPayload({ status: state, positionSeconds, positionUpdatedAt: Date.now() });
});

MediaItem.onMediaTransition(unloads, (mediaItem) => {
	logTrackDetails(mediaItem).catch((error) => logError("onMediaTransition", error));
});

MediaItem.fromPlaybackContext()
	.then((mediaItem) => {
		if (mediaItem) return logTrackDetails(mediaItem);
	})
	.catch((error) => logError("initialPlaybackContext", error));

const extractCoverResourceId = (coverUrl?: string) => {
	if (!coverUrl) return "";
	try {
		const url = new URL(coverUrl);
		const segments = url.pathname.split("/").filter(Boolean);
		if (segments[0] === "images") segments.shift();
		if (segments.length === 0) return "";
		const last = segments[segments.length - 1];
		if (/^[0-9]+x[0-9]+\.[a-z]+$/i.test(last)) segments.pop();
		return segments.join("/");
	} catch {
		return "";
	}
};

function logError(context: string, error: unknown) {
	const normalizedError = error instanceof Error ? error : new Error(String(error));
	trace.err.withContext(context)(normalizedError);
}

type PlaybackControlsState = ReturnType<typeof resolvePlaybackControls>;

const computeElapsedSeconds = (playbackControls: PlaybackControlsState) => {
	const baseSeconds = playbackControls.latestCurrentTime ?? 0;
	if (playbackControls.playbackState !== "PLAYING") return baseSeconds;
	const syncTimestamp = playbackControls.latestCurrentTimeSyncTimestamp;
	if (typeof syncTimestamp === "number" && Number.isFinite(syncTimestamp)) {
		const deltaSeconds = (Date.now() - syncTimestamp) / 1000;
		if (deltaSeconds >= 0) return baseSeconds + deltaSeconds;
	}
	// Fallback to the live player clock when Redux timestamps lag behind.
	const livePosition = PlayState.currentTime;
	return Number.isFinite(livePosition) ? livePosition : baseSeconds;
};

const resolvePlaybackControls = () => PlayState.playbackControls;

const handleRemoteCommand = (command?: RemoteCommand) => {
	if (!command) return trace.warn("[RemoteCommand] Missing command payload");
	const clicked = clickRemoteButton(command);
	if (clicked) {
		trace.log(`[RemoteCommand] Executed ${command}`);
	} else {
		trace.warn(`[RemoteCommand] Failed to execute ${command} - element not found`);
	}
};

const remoteCommandSelectors: Record<RemoteCommand, string[]> = {
	playtoggle: [
		'button[data-test="play-toggle"]',
		'button[data-test="play"]',
		'button[data-test="pause"]',
		'button[aria-label="Play"]',
		'button[aria-label="Pause"]',
	],
	next: ['button[data-test="next"]', 'button[data-test="Next"]', 'button[aria-label="Next"]'],
	prev: ['button[data-test="previous"]', 'button[data-test="prev"]', 'button[aria-label="Previous"]'],
};

const clickRemoteButton = (command: RemoteCommand) => {
	const selectors = remoteCommandSelectors[command];
	for (const selector of selectors) {
		const button = document.querySelector<HTMLButtonElement>(selector);
		if (button) {
			button.click();
			return true;
		}
	}
	if (command === "playtoggle") {
		const toggleButton =
			document.querySelector<HTMLButtonElement>('button[data-test="play-toggle"]') ??
			document.querySelector<HTMLButtonElement>('button[data-test="play"]') ??
			document.querySelector<HTMLButtonElement>('button[data-test="pause"]');
		if (toggleButton) {
			toggleButton.click();
			return true;
		}
	}
	return false;
};

const publishTrackInfo = (payload: TrackStatusPayload) => {
	latestTrackInfo = payload;
	ipcRenderer.send(trackInfoChannel, payload);
};

const updateTrackInfoPayload = (partial: Partial<TrackStatusPayload>) => {
	if (!latestTrackInfo) return;
	publishTrackInfo({ ...latestTrackInfo, ...partial });
};

const getCurrentPositionSeconds = () => {
	const playbackControls = resolvePlaybackControls();
	if (!playbackControls) return 0;
	return computeElapsedSeconds(playbackControls);
};
