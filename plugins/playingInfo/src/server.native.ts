import express, { type Request, type Response } from "express";
import type { Server } from "http";
import type { BrowserWindow } from "electron";

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

export const startCommandServer = async () => {
	if (server !== undefined) return;
	const app = express();

	app.get("/command", (req: Request, res: Response) => {
		console.log(logPrefix, "query", req.query);
		const command = normalizeCommand(req.query.command ?? req.query.cmd ?? req.query.action ?? req.query.op);
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
};
