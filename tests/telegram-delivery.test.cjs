const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const telegram = fs.readFileSync(path.join(root, "lib/telegram.ts"), "utf8");
const cron = fs.readFileSync(path.join(root, "app/api/cron/route.ts"), "utf8");

test("Telegram sender permits exactly the three entry alert types", () => {
  assert.match(
    telegram,
    /type!=="ENTRY_1"&&type!=="ENTRY_2"&&type!=="ADD"/
  );
});

test("cron forwards the generated signal type without remapping it", () => {
  assert.match(cron, /signalType:signal\.type/);
});

test("sender requires Telegram API ok=true and a valid message_id", () => {
  assert.match(telegram, /payload\.ok!==true/);
  assert.match(telegram, /payload\.result\?\.message_id/);
  assert.match(telegram, /\[TELEGRAM\] accepted type=\$\{type\} message_id=\$\{messageId\}/);
});

test("a failed pre-send review releases the claimed lifecycle key", () => {
  assert.match(cron, /telegramClaimed&&!telegramSendStarted&&claimedTelegramKey/);
  assert.match(cron, /released lifecycle claim after pre-send failure/);
});

test("ambiguous Telegram outcomes retain the claim to avoid duplicate messages", () => {
  assert.match(cron, /status=ambiguous_delivery; retaining lifecycle claim/);
});
