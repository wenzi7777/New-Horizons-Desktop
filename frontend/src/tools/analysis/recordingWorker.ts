// Reads and parses a recording off the main thread: an hour at 60 fps with
// 112 sensors is ~200 MB of text, which would freeze the page for seconds.

import { parseRecordingCsv, recordingBuffers, type Recording } from "../../lib/recordingAnalysis";

export type WorkerRequest = { id: number; name: string; source: string | Blob };

export type WorkerReply =
  | { id: number; phase: "reading" | "parsing" }
  | { id: number; recording: Recording }
  | { id: number; error: string };

type WorkerScope = {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
  postMessage(message: WorkerReply, transfer?: Transferable[]): void;
};

const scope = self as unknown as WorkerScope;

async function readSource(source: string | Blob): Promise<string> {
  if (typeof source !== "string") return source.text();
  const response = await fetch(source, { credentials: "same-origin" });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText || "request_failed"}`);
  return response.text();
}

scope.onmessage = async (event) => {
  const { id, name, source } = event.data;
  try {
    scope.postMessage({ id, phase: "reading" });
    const text = await readSource(source);
    scope.postMessage({ id, phase: "parsing" });
    const recording = parseRecordingCsv(text, name);
    scope.postMessage({ id, recording }, recordingBuffers(recording));
  } catch (error) {
    scope.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
};
