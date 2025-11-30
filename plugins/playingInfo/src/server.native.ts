import express, { type Request, type Response } from "express";
import type { Server } from "http";
import { ipcMain, type BrowserWindow } from "electron";
import type { TrackStatusPayload } from "./types";

export type RemoteCommand = "playtoggle" | "next" | "prev";

declare global {
	var luna: {
		modules: Record<string, any>;
		tidalWindow?: BrowserWindow;
	};
}

let server: Server | undefined;

const logPrefix = "[@luna/playnowinfo][command-server]";
const commandChannel = "__luna/playnowinfo/command";
const trackInfoChannel = "__luna/playnowinfo/trackInfo";

let latestTrackInfo: TrackStatusPayload | undefined;
let trackInfoListenerRegistered = false;

const trackInfoListener = (_event: Electron.IpcMainEvent, payload: TrackStatusPayload) => {
	latestTrackInfo = payload;
};

const getLiveTrackInfo = (): TrackStatusPayload | undefined => {
	if (!latestTrackInfo) return undefined;
	if (latestTrackInfo.status !== "PLAYING") return latestTrackInfo;
	const updatedAt = latestTrackInfo.positionUpdatedAt;
	if (typeof updatedAt !== "number" || Number.isNaN(updatedAt)) return latestTrackInfo;
	const deltaSeconds = (Date.now() - updatedAt) / 1000;
	if (deltaSeconds <= 0) return latestTrackInfo;
	const durationSeconds = Number(latestTrackInfo.duration);
	const nextPosition = latestTrackInfo.positionSeconds + deltaSeconds;
	const clampedPosition = Number.isFinite(durationSeconds) && durationSeconds > 0 ? Math.min(nextPosition, durationSeconds) : nextPosition;
	return { ...latestTrackInfo, positionSeconds: clampedPosition };
};

export const startCommandServer = async () => {
	if (server !== undefined) return;
	const app = express();

	if (!trackInfoListenerRegistered) {
		ipcMain.on(trackInfoChannel, trackInfoListener);
		trackInfoListenerRegistered = true;
	}

	app.get("/command", (req: Request, res: Response) => {
		console.log(logPrefix, "query", req.query);
		const commandInput = getQueryValue(req.query.command ?? req.query.cmd ?? req.query.action ?? req.query.op);
		if (isInfoCommand(commandInput)) {
			const liveTrackInfo = getLiveTrackInfo();
			if (!liveTrackInfo) {
				res.status(404).json({ status: "UNKNOWN", message: "No track data" });
				return;
			}
			res.json(liveTrackInfo);
			return;
		}
		const command = normalizeCommand(commandInput);
		if (!command) {
			res.status(400).json({ status: "error", message: "Missing or invalid command" });
			return;
		}
		const dispatched = dispatchCommand(command);
		if (!dispatched) {
			res.status(503).json({ status: "error", message: "Renderer window unavailable" });
			return;
		}
		res.json({ status: "ok", command });
	});

	server = app
		.listen(3900, () => console.log(`${logPrefix} listening on http://localhost:3900/command`))
		.on("error", (error) => {
			console.error(`${logPrefix} error`, error);
		});
};

const getQueryValue = (value: unknown): unknown => {
	if (Array.isArray(value)) return value[0];
	return value;
};

const isInfoCommand = (value: unknown): boolean => {
	if (typeof value !== "string") return false;
	return value.toLowerCase() === "info";
};

const normalizeCommand = (value: unknown): RemoteCommand | undefined => {
	if (typeof value !== "string") return undefined;
	const normalized = value.toLowerCase();
	switch (normalized) {
		case "play":
		case "start":
		case "resume":
		case "stop":
		case "pause":
		case "halt":
		case "playtoggle":
		case "toggle":
			return "playtoggle";
		case "next":
		case "forward":
			return "next";
		case "prev":
		case "previous":
		case "back":
			return "prev";
	}
	return undefined;
};

const dispatchCommand = (command: RemoteCommand) => {
	const tidalWindow = globalThis.luna?.tidalWindow;
	if (tidalWindow === undefined) {
		console.warn(logPrefix, "No tidalWindow found to dispatch command", command);
		return false;
	}
	tidalWindow.webContents.send(commandChannel, command);
	return true;
};

export const stopCommandServer = async () => {
	if (server === undefined) return;
	await new Promise<void>((resolve, reject) => {
		server?.close((error) => {
			if (error) reject(error);
			else resolve();
		});
	});
	server = undefined;
	if (trackInfoListenerRegistered) {
		ipcMain.removeListener(trackInfoChannel, trackInfoListener);
		trackInfoListenerRegistered = false;
	}
};
