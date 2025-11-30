export type TrackUpdatePayload = {
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

export type TrackStatusPayload = TrackUpdatePayload & {
	status: string;
	positionSeconds: number;
};
