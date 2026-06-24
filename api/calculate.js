// api/calculate.js
//
// Vercel Serverless Function
// Receives price calculation data from the calculator page,
// then sends a formatted message to the owner via Telegram Bot API.

export default async function handler(req, res) {
  // Allow the calculator page (any origin) to call this endpoint
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
    const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

    if (!BOT_TOKEN || !CHAT_ID) {
      res.status(500).json({ error: 'Server not configured' });
      return;
    }

    // Build a readable message
    const extrasList = (extras && extras.length > 0)
      ? extras.map(e => `• ${e}`).join('\n')
      : '— без додаткових факторів';

    const who = clientName ? `\n👤 Від: ${clientName}` : '';

    const text =
      `💰 *Новий розрахунок з калькулятора*\n\n` +
      `🎬 Тип відео: *${base}*\n` +
      `${extrasList}\n\n` +
      `💵 Підсумок: *$${total}* / відео${who}`;

    const tgResponse = await fetch(
      `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: CHAT_ID,
          text: text,
          parse_mode: 'Markdown',
        }),
      }
    );

    const tgData = await tgResponse.json();

    if (!tgData.ok) {
      console.error('Telegram API error:', tgData);
      res.status(502).json({ error: 'Failed to send Telegram message' });
      return;
    }

    res.status(200).json({ success: true });
  } catch (err) {
    console.error('Handler error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}
