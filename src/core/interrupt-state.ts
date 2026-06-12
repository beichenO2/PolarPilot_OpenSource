export type InterruptHint = "resume" | "force-stop" | "exit";
export type InterruptDisposition = "request-graceful-stop" | "force-stop" | "exit";

type Snap = { status: "running" | "waiting" | "aborted" | "stopped"; gracefulStopRequested: boolean };

export function getInterruptDisposition(s: Snap): InterruptDisposition {
  if (s.status === "aborted") return "exit";
  if (s.gracefulStopRequested || s.status === "stopped") return "force-stop";
  return "request-graceful-stop";
}

export function getInterruptHint(s: Snap): InterruptHint {
  const d = getInterruptDisposition(s);
  if (d === "exit") return "exit";
  if (d === "force-stop") return "force-stop";
  return "resume";
}
