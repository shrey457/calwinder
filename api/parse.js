module.exports = async (req, res) => {
  // Allow CORS if needed
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, x-user-gemini-key'
  );

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  // 1. Check if user provided their own backup key, otherwise use the server env variable
  const userBackupKey = req.headers['x-user-gemini-key'];
  const apiKey = (userBackupKey && userBackupKey.trim()) ? userBackupKey.trim() : process.env.GEMINI_API_KEY;

  if (!apiKey) {
    return res.status(500).json({ 
      error: 'NO_KEY_CONFIGURED', 
      message: 'Server has no API key set, and no backup key was provided.' 
    });
  }

  try {
    const { promptText } = req.body;
    if (!promptText) {
      return res.status(400).json({ error: 'Missing promptText in request body.' });
    }

    const systemInstruction = `Extract all academic calendar events from this schedule. Return strictly a JSON array of objects with keys: "title" (string), "category" ("Exam"|"Assignment"|"Deadline"|"Lecture"|"Holiday"|"Other"), "date" (YYYY-MM-DD), "startTime" (HH:MM or empty string), "location" (string). Output valid raw JSON only.`;

    const googleRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: `${systemInstruction}\n\nDocument Text:\n${promptText}` }] }]
        })
      }
    );

    const data = await googleRes.json();

    if (!googleRes.ok) {
      // Forward quota or auth errors to the frontend
      return res.status(googleRes.status).json({
        error: googleRes.status === 429 ? 'QUOTA_EXHAUSTED' : 'UPSTREAM_ERROR',
        details: data
      });
    }

    const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text || '[]';
    const cleanJson = rawText.replace(/```json/g, '').replace(/```/g, '').trim();
    
    return res.status(200).json(JSON.parse(cleanJson));
  } catch (err) {
    return res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
  }
};