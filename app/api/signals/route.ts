export const runtime = "nodejs";

let latestSignals: any[] = [];

export function setLatestSignals(signals: any[]) {
  latestSignals = signals;
}

export async function GET() {
  return Response.json({
    signals: latestSignals,
    updatedAt: new Date().toISOString(),
  });
}
