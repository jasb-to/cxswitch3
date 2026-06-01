import { sendTelegram } from "@/lib/telegram";

export async function POST() {
  console.log("[API] POST /api/telegram/test - Test alert requested");

  try {
    await sendTelegram("🧪 TEST ALERT: CX Switch is working");

    return Response.json({
      success: true,
      message: "Test alert sent",
    });
  } catch (err) {
    console.error("[API] Test alert failed", err);

    return Response.json({
      success: false,
      message: "Test alert failed",
    });
  }
}
