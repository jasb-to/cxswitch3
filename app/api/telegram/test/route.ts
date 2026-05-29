import { sendTestAlert } from "@/lib/telegram";

export const runtime = "nodejs";

export async function POST() {
  console.log("[API] POST /api/telegram/test - Test alert requested");

  const result = await sendTestAlert();

  console.log(
    `[API] Test alert result: success=${result.success}, message=${result.message}`
  );

  return Response.json(result);
}
