const https = require("https");

function sendTelegramMessage(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  const enabled = (process.env.TELEGRAM_ENABLED || "true").toLowerCase() === "true";

  if (!enabled || !token || !chatId) {
    return Promise.resolve();
  }

  const payload = JSON.stringify({
    chat_id: chatId,
    text,
  });

  const options = {
    hostname: "api.telegram.org",
    path: `/bot${token}/sendMessage`,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(payload),
    },
  };

  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => {
        data += chunk;
      });
      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          return resolve();
        }
        reject(
          new Error(
            `Telegram API error (${res.statusCode}): ${data || "no response"}`
          )
        );
      });
    });

    req.on("error", (err) => reject(err));
    req.write(payload);
    req.end();
  });
}

function formatOrderMessage(order, requester) {
  if (!order) {
    return "New order received.";
  }

  const totalDiamonds = order.quantity * order.diamond_amount;
  const nickname = requester?.nickname;
  const name = requester?.name;
  const requesterName = nickname || name;
  const requesterIdNumber = requester?.id_number;
  const requesterLabel =
    nickname && name && nickname !== name
      ? `${nickname} (${name})`
      : requesterName;
  const requesterLine = requesterName
    ? `Requester: ${requesterLabel}${requesterIdNumber ? ` (${requesterIdNumber})` : ""}`
    : requesterIdNumber
      ? `Requester: ${requesterIdNumber}`
      : `Requester: User #${order.user_id}`;
  const lines = [
    "New order received",
    `Order: ${order.order_number}`,
    requesterLine,
    order.client_imo_id ? `IMO ID: ${order.client_imo_id}` : null,
    `Diamonds: ${order.quantity} x ${order.diamond_amount} = ${totalDiamonds}`,
    `Diamond Amount: ${order.points_used}`,
  ].filter(Boolean);

  return lines.join("\n");
}

function sendTelegramOrderNotification(order, requester) {
  const message = formatOrderMessage(order, requester);
  return sendTelegramMessage(message);
}

function formatUserRegistrationMessage(user) {
  if (!user) {
    return "New user registration submitted.";
  }

  const nickname = user.nickname;
  const name = user.name;
  const email = user.email;
  const idNumber = user.id_number;
  const phoneNumber = user.phone_number;
  const displayName =
    nickname && name && nickname !== name ? `${nickname} (${name})` : nickname || name;

  const lines = [
    "New user registration submitted",
    displayName ? `Name: ${displayName}` : null,
    email ? `Email: ${email}` : null,
    idNumber ? `ID Number: ${idNumber}` : null,
    phoneNumber ? `Phone: ${phoneNumber}` : null,
  ].filter(Boolean);

  return lines.join("\n");
}

function sendTelegramUserRegistrationNotification(user) {
  const message = formatUserRegistrationMessage(user);
  return sendTelegramMessage(message);
}

module.exports = {
  sendTelegramOrderNotification,
  sendTelegramUserRegistrationNotification,
};
