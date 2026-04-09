import "dotenv/config";

const workerUrl = process.argv[2];

if (!workerUrl) {
  console.error("Usage: node worker/scripts/set-webhook.js https://your-worker.workers.dev");
  process.exit(1);
}

if (!process.env.TELEGRAM_BOT_TOKEN) {
  console.error("TELEGRAM_BOT_TOKEN is missing in .env");
  process.exit(1);
}

const webhookUrl = `${workerUrl.replace(/\/$/, "")}/telegram/webhook`;
const response = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/setWebhook`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    url: webhookUrl,
    allowed_updates: ["message", "channel_post", "callback_query"]
  })
});

const payload = await response.json();
console.log(JSON.stringify({ webhookUrl, response: payload }, null, 2));
