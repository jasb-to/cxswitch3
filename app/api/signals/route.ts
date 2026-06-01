import { getLatestSignalSnapshots } from "@/lib/persistence";

export const runtime = "nodejs";

export async function GET() {
  try {
    const signals = await getLatestSignalSnapshots();

    return Response.json({
      signals: signals ?? [],
      updatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error("[API ERROR]", err);

    return Response.json(
      { signals: [], error: "Failed" },
      { status: 500 }
    );
  }
}
