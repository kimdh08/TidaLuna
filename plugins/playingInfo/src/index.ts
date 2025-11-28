import { Tracer, type LunaUnload } from "@luna/core";
import { MediaItem, PlayState, getPlaybackInfo } from "@luna/lib";

export const unloads = new Set<LunaUnload>();

const { trace } = Tracer("[playingInfo]");

let activeMediaItem: MediaItem | undefined;
let activeDurationSeconds = 0;
let lastTrackMeta: {
	title: string;
	artist?: string;
	album?: string;
	quality?: string;
} | undefined;

const logTrackDetails = async (mediaItem: MediaItem) => {
	activeMediaItem = mediaItem;
	const playbackContext = PlayState.playbackContext;
	const chosenQuality = playbackContext?.actualAudioQuality ?? mediaItem.bestQuality.audioQuality;

	try {
		const [title, albumTitle, artistName, coverUrl, playbackInfo] = await Promise.all([
			mediaItem.title(),
			mediaItem.album().then((album) => album?.title()),
			mediaItem
				.artist()
				.then((artist) => artist?.name),
			mediaItem.coverUrl({ res: "640" }),
			getPlaybackInfo(mediaItem.id, chosenQuality),
		]);

		activeDurationSeconds = playbackContext?.actualDuration ?? mediaItem.duration ?? 0;

		trace.log(
			`[Now Playing] ${title} — ${artistName ?? "Unknown Artist"} (${albumTitle ?? "Unknown Album"}) | Quality: ${playbackInfo.audioQuality}`,
		);
		if (coverUrl) trace.log(`[Artwork] ${coverUrl}`);
		lastTrackMeta = {
			title,
			artist: artistName ?? "Unknown Artist",
			album: albumTitle ?? "Unknown Album",
			quality: playbackInfo.audioQuality,
		};
	} catch (error) {
		logError("logTrackDetails", error);
	}
};

let lastPlaybackState: PlaybackControlsState["playbackState"] | undefined;

const progressInterval = setInterval(() => {
	if (activeMediaItem === undefined) return;
	const playbackControls = resolvePlaybackControls();
	const state = playbackControls.playbackState;
	const hasStateChanged = state !== lastPlaybackState;
	const shouldLog = state === "PLAYING" || hasStateChanged;
	if (!shouldLog) return;

	const elapsedSeconds = computeElapsedSeconds(playbackControls);
	const durationSeconds = activeDurationSeconds || playbackControls.playbackContext?.actualDuration || activeMediaItem.duration || 0;
	if (!durationSeconds) return;
	const percent = Math.min((elapsedSeconds / durationSeconds) * 100, 100);
	const trackSummary = lastTrackMeta
		? `${lastTrackMeta.title} — ${lastTrackMeta.artist} (${lastTrackMeta.album}) | Quality: ${lastTrackMeta.quality ?? "?"}`
		: "Unknown Track";
	trace.log(
		`[Progress] ${formatTime(elapsedSeconds)} / ${formatTime(durationSeconds)} (${percent.toFixed(1)}%) - State: ${state} :: ${trackSummary}`,
	);
	lastPlaybackState = state;
}, 1000);

const intervalUnload: LunaUnload = () => clearInterval(progressInterval);
intervalUnload.source = "progressInterval";
unloads.add(intervalUnload);

MediaItem.onMediaTransition(unloads, (mediaItem) => {
	logTrackDetails(mediaItem).catch((error) => logError("onMediaTransition", error));
});

MediaItem.fromPlaybackContext()
	.then((mediaItem) => {
		if (mediaItem) return logTrackDetails(mediaItem);
	})
	.catch((error) => logError("initialPlaybackContext", error));

const formatTime = (value: number) => {
	if (!Number.isFinite(value)) return "00:00";
	const totalSeconds = Math.max(0, Math.floor(value));
	const mins = Math.floor(totalSeconds / 60)
		.toString()
		.padStart(2, "0");
	const secs = (totalSeconds % 60)
		.toString()
		.padStart(2, "0");
	return `${mins}:${secs}`;
};

const logError = (context: string, error: unknown) => {
	const normalizedError = error instanceof Error ? error : new Error(String(error));
	trace.err.withContext(context)(normalizedError);
};

type PlaybackControlsState = ReturnType<typeof resolvePlaybackControls>;

const computeElapsedSeconds = (playbackControls: PlaybackControlsState) => {
	const baseSeconds = playbackControls.latestCurrentTime ?? 0;
	if (playbackControls.playbackState !== "PLAYING") return baseSeconds;
	const syncTimestamp = playbackControls.latestCurrentTimeSyncTimestamp;
	if (typeof syncTimestamp !== "number" || Number.isNaN(syncTimestamp)) return baseSeconds;
	const deltaSeconds = (Date.now() - syncTimestamp) / 1000;
	return baseSeconds + Math.max(deltaSeconds, 0);
};

const resolvePlaybackControls = () => PlayState.playbackControls;
