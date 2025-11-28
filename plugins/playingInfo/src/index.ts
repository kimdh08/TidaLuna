import { Tracer, type LunaUnload } from "@luna/core";

export const unloads = new Set<LunaUnload>();

const { trace } = Tracer("[playingInfo]");
trace.log("Play Info Goes on!");
