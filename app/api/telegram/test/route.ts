import { sendTelegram } from "@/lib/telegram";

export const runtime = "nodejs";

export async function GET() {
  try {
    await sendTelegram(
      "✅ CX SWITCH TEST ALERT\nTelegram integration working."
    );

    return Response.json({
      ok: true,
      message: "Test alert sent",
    });
  } catch (err: any) {
    console.error("[TEST ALERT ERROR]", err);

    return Response.json({
      ok: false,
      error: err?.message || "unknown error",
    });
  }
}
