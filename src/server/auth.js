import crypto from "node:crypto";

const MAX_AUTH_AGE_SECONDS = 24 * 60 * 60;

export function telegramAuth(req, res, next) {
  const initData = readInitData(req);

  if (!initData && process.env.ALLOW_DEV_AUTH === "true") {
    req.telegramUser = {
      id: "dev-user",
      first_name: "Dev",
      username: "local"
    };
    return next();
  }

  if (!initData) {
    return res.status(401).json({ error: "Telegram initData is required." });
  }

  try {
    req.telegramUser = validateTelegramInitData(initData, process.env.TELEGRAM_BOT_TOKEN);
    return next();
  } catch (error) {
    return res.status(401).json({ error: error.message });
  }
}

export function optionalTelegramAuth(req, _res, next) {
  const initData = readInitData(req);

  if (!initData) {
    req.telegramUser = process.env.ALLOW_DEV_AUTH === "true"
      ? { id: "dev-user", first_name: "Dev", username: "local" }
      : null;
    return next();
  }

  try {
    req.telegramUser = validateTelegramInitData(initData, process.env.TELEGRAM_BOT_TOKEN);
  } catch {
    req.telegramUser = null;
  }

  return next();
}

export function validateTelegramInitData(initData, botToken) {
  if (!botToken) {
    throw new Error("TELEGRAM_BOT_TOKEN is required for Mini App auth.");
  }

  const params = new URLSearchParams(initData);
  const hash = params.get("hash");

  if (!hash) {
    throw new Error("Invalid Telegram initData: hash is missing.");
  }

  params.delete("hash");

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

  const secretKey = crypto.createHmac("sha256", "WebAppData").update(botToken).digest();
  const calculatedHash = crypto.createHmac("sha256", secretKey).update(dataCheckString).digest("hex");

  if (!safeEqual(hash, calculatedHash)) {
    throw new Error("Invalid Telegram initData: hash mismatch.");
  }

  const authDate = Number(params.get("auth_date"));
  const age = Math.floor(Date.now() / 1000) - authDate;

  if (!authDate || age > Number(process.env.TELEGRAM_INIT_DATA_MAX_AGE || MAX_AUTH_AGE_SECONDS)) {
    throw new Error("Invalid Telegram initData: auth data is too old.");
  }

  const userRaw = params.get("user");
  const user = userRaw ? JSON.parse(userRaw) : null;

  if (!user?.id) {
    throw new Error("Invalid Telegram initData: user is missing.");
  }

  return {
    ...user,
    id: String(user.id)
  };
}

function readInitData(req) {
  const auth = req.get("authorization") || "";

  if (auth.toLowerCase().startsWith("tma ")) {
    return auth.slice(4);
  }

  return req.get("x-telegram-init-data") || "";
}

function safeEqual(a, b) {
  const first = Buffer.from(a, "hex");
  const second = Buffer.from(b, "hex");

  return first.length === second.length && crypto.timingSafeEqual(first, second);
}
