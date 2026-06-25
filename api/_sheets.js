// api/_sheets.js
//
// Shared helper for writing to Google Sheets via the Sheets API,
// authenticated as a Service Account. We sign the JWT ourselves
// using Node's built-in `crypto` module instead of pulling in the
// full `googleapis` package — keeps cold starts fast on Vercel.
//
// Required environment variables:
//   GOOGLE_SERVICE_ACCOUNT_EMAIL — from the service account JSON ("client_email")
//   GOOGLE_PRIVATE_KEY           — from the service account JSON ("private_key")
//                                   (keep the \n escape sequences as-is in Vercel env vars)
//   GOOGLE_SHEET_ID              — the long id in the sheet's URL between /d/ and /edit
//   GOOGLE_SHEET_NAME            — tab name, e.g. "Замовлення" (defaults to that)

import crypto from 'crypto';

const SERVICE_ACCOUNT_EMAIL = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;

// Handles the private key whether Vercel stored it with literal "\n"
// sequences or with real newline characters — strips surrounding quotes
// if present, then normalizes to real newlines either way.
function normalizePrivateKey(raw) {
  if (!raw) return '';
  let key = raw.trim();
  // Strip accidental wrapping quotes (e.g. pasted with quotes included)
  if ((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'"))) {
    key = key.slice(1, -1);
  }
  // Convert literal backslash-n sequences into real newlines
  key = key.replace(/\\n/g, '\n');
  return key;
}

const PRIVATE_KEY = normalizePrivateKey(process.env.GOOGLE_PRIVATE_KEY);
const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const SHEET_NAME = process.env.GOOGLE_SHEET_NAME || 'Замовлення';

function isSheetsConfigured() {
  return Boolean(SERVICE_ACCOUNT_EMAIL && PRIVATE_KEY && SHEET_ID);
}

function base64url(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Builds and signs a JWT for Google's OAuth2 service-account flow,
 * then exchanges it for a short-lived access token.
 */
async function getAccessToken() {
  const header = { alg: 'RS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: SERVICE_ACCOUNT_EMAIL,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now,
  };

  const unsigned = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(unsigned);
  signer.end();
  const signature = signer.sign(PRIVATE_KEY);
  const signatureB64 = signature
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  const jwt = `${unsigned}.${signatureB64}`;

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });

  const rawText = await response.text();
  console.log('Token exchange status:', response.status);
  console.log('Token exchange response (first 300 chars):', rawText.slice(0, 300));

  let data;
  try {
    data = JSON.parse(rawText);
  } catch (parseErr) {
    console.error('Token exchange response was not JSON:', rawText.slice(0, 500));
    throw new Error(`Google token exchange returned non-JSON response (status ${response.status})`);
  }

  if (!response.ok) {
    console.error('Google token exchange error:', data);
    throw new Error('Failed to get Google access token');
  }

  return data.access_token;
}

/**
 * Appends a new order row to the sheet.
 * Column order MUST match the header row exactly:
 * ID замовлення | Дата і час | Клієнт | Пакет | Додаткові фактори | Сума |
 * Статус замовлення | Хто забрав | Статус оплати | Сума оплачено | Дата оплати
 *
 * Returns the 1-based row number of the newly inserted row, or null on failure.
 */
async function appendOrderRow({ orderId, clientName, packageLabel, extras, total }) {
  if (!isSheetsConfigured()) {
    console.warn('Google Sheets not configured — skipping row append');
    return null;
  }

  try {
    const accessToken = await getAccessToken();

    const row = [
      orderId,
      new Date().toISOString(),
      clientName || '—',
      packageLabel,
      (extras && extras.length > 0) ? extras.join('\n') : '—',
      total,
      'Нове',
      '',
      'Не оплачено',
      '',
      '',
    ];

    const range = `${SHEET_NAME}!A:A`;
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ values: [row] }),
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('Sheets append error:', data);
      return null;
    }

    // data.updates.updatedRange looks like "Замовлення!A5:K5" — extract the row number.
    const match = /![A-Z]+(\d+):/.exec(data.updates?.updatedRange || '');
    return match ? parseInt(match[1], 10) : null;
  } catch (err) {
    console.error('Sheets append exception:', err);
    return null;
  }
}

/**
 * Updates specific cells in an existing row by row number.
 * `updates` is an object like { 'Статус замовлення': 'В роботі', 'Хто забрав': 'Сашко' }
 * using the same header names as the sheet's first row.
 */
const COLUMN_LETTERS = {
  'ID замовлення': 'A',
  'Дата і час': 'B',
  'Клієнт': 'C',
  'Пакет': 'D',
  'Додаткові фактори': 'E',
  'Сума': 'F',
  'Статус замовлення': 'G',
  'Хто забрав': 'H',
  'Статус оплати': 'I',
  'Сума оплачено': 'J',
  'Дата оплати': 'K',
};

async function updateOrderRow(rowNumber, updates) {
  if (!isSheetsConfigured() || !rowNumber) return null;

  try {
    const accessToken = await getAccessToken();

    const data = Object.entries(updates).map(([columnName, value]) => {
      const letter = COLUMN_LETTERS[columnName];
      return {
        range: `${SHEET_NAME}!${letter}${rowNumber}`,
        values: [[value]],
      };
    });

    const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values:batchUpdate`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        valueInputOption: 'USER_ENTERED',
        data,
      }),
    });

    const result = await response.json();

    if (!response.ok) {
      console.error('Sheets update error:', result);
      return null;
    }

    return result;
  } catch (err) {
    console.error('Sheets update exception:', err);
    return null;
  }
}

export { appendOrderRow, updateOrderRow, isSheetsConfigured };
