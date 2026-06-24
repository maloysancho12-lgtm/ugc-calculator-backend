// api/calculate.js
//
// Vercel Serverless Function
// Receives price calculation data from the calculator page,
// then sends a formatted message WITH a "Claim order" button
// to both the owner and the partner via Telegram Bot API.
// Order claim state is stored in Upstash Redis so the webhook
// (api/telegram-webhook.js) can enforce "first click wins".

import { Redis } from '@upstash/redis';
import { appendOrderRow } from './_sheets.js';

const redis = Redis.fromEnv();

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const { base, extras, total, clientName } = req.body;

    if (!base || total === undefined) {
      res.status(400).json({ error: 'Missing required fields' });
      return;
    }

    const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
    const OWNER_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
    const PARTNER_CHAT_ID = process.env.TELEGRAM_PARTNER_CHAT_ID;

    if (!BOT_TOKEN || !OWNER_CHAT_ID) {
      res.status(500).json({ error: 'Server not configured' });
      return;
    }

    const orderId = `order_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    const extrasList = (extras && extras.length > 0)
      ? extras.map(e => `• ${e}`).join('\n')
      : '— без додаткових факторів';

    const who = clientName ? `\n👤 Від: ${clientName}` : '';

    const text =
      `💰 *Новий розрахунок з калькулятора*\n\n` +
      `📦 Пакет: *${base}*\n` +
      `${extrasList}\n\n` +
      `💵 Підсумок: *$${total}*${who}`;

    const recipients = [OWNER_CHAT_ID];
    if (PARTNER_CHAT_ID) recipients.push(PARTNER_CHAT_ID);

    const messages = {};

    for (const chatId of recipients) {
      const tgResponse = await fetch(
        `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            text: text,
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [[
                { text: '✅ Забираю замовлення', callback_data: `claim:${orderId}` }
              ]]
            }
          }),
        }
      );

      const tgData = await tgResponse.json();

      if (tgData.ok) {
        messages[chatId] = tgData.result.message_id;
      } else {
        console.error('Telegram send error for', chatId, tgData);
      }
    }

    // Append the order as a new row in Google Sheets for bookkeeping.
    const sheetRow = await appendOrderRow({
      orderId,
      clientName,
      packageLabel: base,
      extras,
      total,
    });

    // Store order state so the webhook can validate the claim,
    // edit both copies of the message, and update the Sheets row.
    await redis.set(orderId, {
      claimed: false,
      claimedBy: null,
      text,
      messages, // { chat_id: message_id }
      sheetRow,
    }, { ex: 60 * 60 * 24 * 7 }); // expires after 7 days

    res.status(200).json({ success: true, orderId });
  } catch (err) {
    console.error('Handler error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}
