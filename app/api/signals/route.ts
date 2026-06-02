import { getSignals } from "@/lib/state";

export const runtime = "nodejs";

export async function GET() {
  const state = getSignals();

  return Response.json({
    signals: state.signals,
    updatedAt: new Date(state.updatedAt).toISOString(),
  });
}
