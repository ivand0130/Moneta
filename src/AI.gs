/**
 * AI.gs — Gemini calls with JSON-only prompts and graceful fallback.
 *
 * Any failure (AI turned off, no key, rate limit, bad answer) returns null
 * and is written to the Logs tab; the caller then falls back to buttons.
 * Note: UrlFetchApp has no timeout setting, so a slow Gemini reply delays the
 * preview; the bot shows "typing…" meanwhile.
 */

const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/';

/**
 * Sends a prompt and returns the parsed JSON answer, or null on any failure.
 * The key goes in a header (not the URL) so it can never appear in logs.
 */
function callGeminiJson_(prompt, source) {
  if (!getSettingYes_(SETTING.AI_ENABLED)) return null;
  const key = getProp_(PROP.GEMINI_KEY);
  if (key === null) {
    logAiFailure_(source, 'GEMINI_KEY is not set');
    return null;
  }
  const model = getSetting_(SETTING.GEMINI_MODEL);
  let response;
  try {
    response = UrlFetchApp.fetch(GEMINI_URL + encodeURIComponent(model) + ':generateContent', {
      method: 'post',
      contentType: 'application/json',
      headers: { 'x-goog-api-key': key },
      muteHttpExceptions: true,
      payload: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0, responseMimeType: 'application/json' }
      })
    });
  } catch (err) {
    logAiFailure_(source, 'network error');
    return null;
  }
  const code = response.getResponseCode();
  if (code !== 200) {
    logAiFailure_(source, code === 429 ? 'rate limit (HTTP 429)' : 'HTTP ' + code,
      response.getContentText().slice(0, 300));
    return null;
  }
  try {
    const body = JSON.parse(response.getContentText());
    const text = body.candidates[0].content.parts[0].text;
    return JSON.parse(text);
  } catch (err) {
    logAiFailure_(source, 'unreadable answer', response.getContentText().slice(0, 300));
    return null;
  }
}

function logAiFailure_(source, message, details) {
  console.warn('[AI ' + source + '] ' + message);
  try {
    writeLogRow_('WARN', 'AI/' + source, message, details);
  } catch (err) {
    console.warn('logAiFailure_: ' + err.message);
  }
}

/**
 * Asks Gemini to pick one category from the list for this note.
 * Returns a category name from the list, or null.
 */
function aiSuggestCategory_(note, type, categoryNames) {
  if (!note || categoryNames.length === 0) return null;
  const prompt = [
    'You categorize personal finance transactions for a household in Indonesia.',
    'The note may be in Bahasa Indonesia, English, or both.',
    'Transaction type: ' + type,
    'Note: ' + JSON.stringify(note),
    'Choose exactly one category from this list: ' + JSON.stringify(categoryNames),
    'If none fits reasonably, use an empty string.',
    'Reply with JSON only, like {"category": "Food", "confidence": 0.9}'
  ].join('\n');
  const answer = callGeminiJson_(prompt, 'category');
  if (answer === null || typeof answer.category !== 'string' || answer.category === '') return null;
  if (typeof answer.confidence === 'number' && answer.confidence < 0.5) return null;
  const match = categoryNames.filter(function (n) { return n.toLowerCase() === answer.category.toLowerCase(); })[0];
  if (!match) {
    logAiFailure_('category', 'answer not in category list', answer.category);
    return null;
  }
  return match;
}
