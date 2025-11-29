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
			const detailsLogParts = [
				`trackid=${mediaItem.id}`,
				`imgurl=${coverUrl ?? "Unknown"}`,
				`audioquality=${playbackInfo.audioQuality}`,
				`releasedate=${releaseDateStr}`,
				`isrc=${isrc ?? "Unknown"}`,
				`popularity=${popularity}`,
				`duration=${activeDurationSeconds || "Unknown"}`,
				`title=${title}`,
				`album=${albumTitle ?? "Unknown Album"}`,
				`artist=${artistName ?? "Unknown Artist"}`,
			];
			// trace.log(`[Track Details] ${detailsLogParts.join(" | ")}`);
			sendTrackUpdate({
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
			}).catch((error: unknown) => logError("sendTrackUpdate", error));

		// trace.log(
		// 	`[Now Playing] ${title} — ${artistName ?? "Unknown Artist"} (${albumTitle ?? "Unknown Album"}) | Quality: ${playbackInfo.audioQuality}`,
		// );
		if (coverUrl) trace.log(`[Artwork] ${title} - ${coverUrl}`);
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
	// trace.log(
	// 	`[Progress] ${formatTime(elapsedSeconds)} / ${formatTime(durationSeconds)} (${percent.toFixed(1)}%) - State: ${state} :: ${trackSummary}`,
	// );
	sendProgressUpdate(elapsedSeconds).catch((error: unknown) => logError("sendProgressUpdate", error));
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

type TrackUpdatePayload = {
	album: string;
	artist: string;
	audioquality: string;
	duration: string;
	imgurl: string;
	isrc: string;
	popularity: string;
	releasedate: string;
	title: string;
	trackid: string;
};

const sendTrackUpdate = async (payload: TrackUpdatePayload) => {
	const params = new URLSearchParams(payload);
	const sUrl = `http://localhost:3888/settrackid?${params.toString()}`;
	// trace.log("Sending track update to Tidalspi:", sUrl);
	try {
		const response = await fetch(sUrl);
		const result = await response.text();
		// trace.log(`settrackid result: ${result}`);
	} catch (error) {
		trace.warn("Tidalspi connection error");
		throw error;
	}
};

const sendProgressUpdate = async (positionSeconds: number) => {
	const params = new URLSearchParams({ position: String(positionSeconds) });
	const sUrl = `http://localhost:3888/setprogress?${params.toString()}`;
	try {
		// trace.log("Sending Progress to Tidalspi:", sUrl);
		const response = await fetch(sUrl);
		const result = await response.text();
		// trace.log(`setprogress result: ${result}`);
	} catch (error) {
		trace.warn("Tidalspi progress connection error");
		throw error;
	}
};

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
