module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,POST');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, x-user-gemini-key'
  );

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'METHOD_NOT_ALLOWED' });

  const userBackupKey = req.headers['x-user-gemini-key'];
  const apiKey = (userBackupKey && userBackupKey.trim()) ? userBackupKey.trim() : process.env.GEMINI_API_KEY;

  if (!apiKey || !apiKey.trim()) {
    return res.status(500).json({ 
      error: 'NO_KEY_CONFIGURED', 
      message: 'No server GEMINI_API_KEY found, and no custom key provided.' 
    });
  }

  try {
    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch (e) { /* ignore */ }
    }

    const { promptText } = body || {};
    if (!promptText) {
      return res.status(400).json({ error: 'MISSING_PAYLOAD', message: 'No document text received.' });
    }

    const systemPrompt = `You are an expert academic calendar parser.
The user will provide raw text extracted from an academic calendar PDF.
Reconstruct the schedule and identify every single academic event, exam (MTE, ETE, Midterm, End Term), quiz, holiday (e.g. Makar Sankranti, Republic Day), semester start/end, break, registration date, and grade/answer script display date.

Return STRICTLY a JSON array of objects with these keys:
- "title": event name (e.g. "Commencement of Even Semester", "Mid-Term Examination (MTE)", "Makar Sankranti")
- "category": one of ["Exam", "Assignment", "Deadline", "Lecture", "Holiday", "Other"]
- "date": ISO date format "YYYY-MM-DD". Infer the year accurately based on the calendar context
- "startTime": string in "HH:MM" (e.g. "09:00") or empty string "" if all-day
- "location": venue or room, or empty string "" if unspecified`;

    const payload = JSON.stringify({
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents: [{ parts: [{ text: `Here is the academic calendar document:\n\n${promptText}` }] }],
      generationConfig: {
        response_mime_type: "application/json",
        temperature: 0.1
      }
    });

    // Cascade models: try gemini-3.8-flash, fallback to gemini-1.5-flash
    const candidateModels = ['gemini-3.8-flash', 'gemini-1.5-flash'];
    let lastError = null;

    for (const model of candidateModels) {
      // Retry each model up to 2 times if Google returns a temporary 503 / high demand spike
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
          const googleRes = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: payload
          });

          const data = await googleRes.json();

          if (googleRes.ok) {
            const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text || '[]';
            const parsed = JSON.parse(rawText.replace(/```json/g, '').replace(/```/g, '').trim());
            return res.status(200).json(parsed);
          }

          const errMsg = data.error?.message || '';
          const isHighDemand = googleRes.status === 503 || errMsg.toLowerCase().includes('high demand') || errMsg.toLowerCase().includes('overloaded');

          if (isHighDemand && attempt === 1) {
            // Wait 1.5s before retrying the same model
            await new Promise(resolve => setTimeout(resolve, 1500));
            continue;
          }

          lastError = { status: googleRes.status, message: errMsg || JSON.stringify(data) };
          break; // Move to next model in cascade
        } catch (fetchErr) {
          lastError = { status: 500, message: fetchErr.message };
        }
      }
    }

    return res.status(lastError?.status || 500).json({
      error: 'ALL_MODELS_BUSY',
      message: lastError?.message || 'Google servers are temporarily saturated. Please retry in a few seconds.'
    });

  } catch (err) {
    return res.status(500).json({ error: 'SERVER_EXCEPTION', message: err.message });
  }
};