import { sendTelegram } from "@/lib/telegram";

export const runtime = "nodejs";

export async function POST() {
  try {
    await sendTelegram("✅ CX Switch Telegram Test");

    return Response.json({
      ok: true,
      message: "Test sent",
    });
  } catch (err) {
    console.error(err);

    return Response.json(
      {
        ok: false,
        error: String(err),
      },
      {
        status: 500,
      }
    );
  }
}
