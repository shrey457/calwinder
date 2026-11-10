module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,POST');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, x-user-gemini-key'
  );

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'METHOD_NOT_ALLOWED', message: 'Only POST is supported.' });
  }

  // 1. Pick up user key from header or fall back to Vercel env variable
  const userBackupKey = req.headers['x-user-gemini-key'];
  const apiKey = (userBackupKey && userBackupKey.trim()) ? userBackupKey.trim() : process.env.GEMINI_API_KEY;

  if (!apiKey || !apiKey.trim()) {
    return res.status(500).json({ 
      error: 'NO_KEY_CONFIGURED', 
      message: 'No server GEMINI_API_KEY environment variable found, and no custom key provided.' 
    });
  }

  try {
    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch (e) { /* ignore */ }
    }

    const { promptText } = body || {};
    if (!promptText) {
      return res.status(400).json({ error: 'MISSING_PAYLOAD', message: 'No document text was received.' });
    }

    const systemPrompt = `You are an expert academic calendar parser.
The user will provide raw text extracted from an academic calendar PDF (often formatted in tables, columns, or separate blocks of dates and event titles).
Reconstruct the schedule and identify every single academic event, exam (MTE, ETE, Midterm, End Term), quiz, holiday (e.g. Makar Sankranti, Republic Day), semester start/end, break, registration date, and grade/answer script display date.

Return STRICTLY a JSON array of objects with these keys:
- "title": event name (e.g. "Commencement of Even Semester", "Mid-Term Examination (MTE)", "Makar Sankranti")
- "category": one of ["Exam", "Assignment", "Deadline", "Lecture", "Holiday", "Other"]
- "date": ISO date format "YYYY-MM-DD". Infer the year accurately (use 2026/2027 based on the calendar text)
- "startTime": string in "HH:MM" (e.g. "09:00") or empty string "" if all-day
- "location": venue or room, or empty string "" if unspecified`;

    // Uses gemini-2.0-flash (stable on Google AI Studio) with strict JSON output
    const googleRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: systemPrompt }] },
          contents: [{ parts: [{ text: `Here is the academic calendar document:\n\n${promptText}` }] }],
          generationConfig: {
            response_mime_type: "application/json",
            temperature: 0.1
          }
        })
      }
    );

    const data = await googleRes.json();

    if (!googleRes.ok) {
      const errMsg = data.error?.message || JSON.stringify(data);
      if (googleRes.status === 429) {
        return res.status(429).json({ error: 'QUOTA_EXHAUSTED', message: errMsg });
      }
      return res.status(googleRes.status).json({ error: 'UPSTREAM_ERROR', message: errMsg });
    }

    const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text || '[]';
    const parsed = JSON.parse(rawText);
    return res.status(200).json(parsed);

  } catch (err) {
    return res.status(500).json({ error: 'SERVER_EXCEPTION', message: err.message });
  }
};