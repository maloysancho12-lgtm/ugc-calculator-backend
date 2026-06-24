// api/telegram-webhook.js
//
// Vercel Serverless Function
// Telegram calls this URL every time a user interacts with the bot
// (here: presses the "✅ Забираю замовлення" inline button).
// Uses Upstash Redis to enforce "first click wins", then edits the
// message in BOTH the owner's and the partner's chat.

import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const update = req.body;
    const callback = update.callback_query;

    // We only care about callback button presses here.
    if (!callback) {
      res.status(200).json({ ok: true });
      return;
    }

    const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
    const data = callback.data || '';

    if (!data.startsWith('claim:')) {
      // Unknown callback — acknowledge so Telegram stops the loading spinner.
      await answerCallback(BOT_TOKEN, callback.id, '');
      res.status(200).json({ ok: true });
      return;
    }

    const orderId = data.slice('claim:'.length);
    const clickerName = [callback.from.first_name, callback.from.last_name]
      .filter(Boolean)
      .join(' ');

    const order = await redis.get(orderId);

    if (!order) {
      await answerCallback(BOT_TOKEN, callback.id, 'Замовлення не знайдено або застаріло.');
      res.status(200).json({ ok: true });
      return;
    }

    if (order.claimed) {
      // Someone already claimed it — just notify this clicker quietly.
      await answerCallback(
        BOT_TOKEN,
        callback.id,
        `Вже забрав: ${order.claimedBy}`
      );
      res.status(200).json({ ok: true });
      return;
    }

    // First click wins — mark as claimed immediately to avoid race conditions.
    order.claimed = true;
    order.claimedBy = clickerName;
    await redis.set(orderId, order, { ex: 60 * 60 * 24 * 7 });

    await answerCallback(BOT_TOKEN, callback.id, 'Забрано! ✅');

    // Edit the message in every chat it was sent to.
    const updatedText = `${order.text}\n\n✅ *Забрав: ${clickerName}*`;

    for (const [chatId, messageId] of Object.entries(order.messages)) {
      await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/editMessageText`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          message_id: messageId,
          text: updatedText,
          parse_mode: 'Markdown',
        }),
      });
    }

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Webhook handler error:', err);
    res.status(200).json({ ok: true });
  }
}

async function answerCallback(botToken, callbackQueryId, text) {
  await fetch(`https://api.telegram.org/bot${botToken}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      callback_query_id: callbackQueryId,
      text: text || undefined,
    }),
  });
}
