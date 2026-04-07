import { analyticsStore, getUserIdFromContext } from "../storage/analyticsStore.js";

export function registerBotAnalytics(bot) {
  bot.use(async (ctx, next) => {
    await trackContext(ctx);
    return next();
  });
}

async function trackContext(ctx) {
  try {
    const messageText = ctx.message?.text || ctx.channelPost?.text || "";
    const callbackData = ctx.callbackQuery?.data;

    if (messageText.startsWith("/")) {
      await analyticsStore.track({
        type: "bot_command",
        action: messageText.split(/\s+/)[0].replace("/", ""),
        source: ctx.chat?.type || "unknown",
        userId: getUserIdFromContext(ctx)
      });
      return;
    }

    if (callbackData) {
      await analyticsStore.track({
        type: "bot_button",
        action: callbackData.split(":")[0],
        label: callbackData,
        source: ctx.chat?.type || "unknown",
        userId: getUserIdFromContext(ctx)
      });
    }
  } catch (error) {
    console.warn(`Analytics tracking failed: ${error.message}`);
  }
}
