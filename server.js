const express = require('express');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

// Serve static files from the 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

// Securely provide Supabase config to the frontend via Environment Variables
app.get('/api/config', (req, res) => {
    res.json({
        url: process.env.SUPABASE_URL || 'YOUR_SUPABASE_URL',
        key: process.env.SUPABASE_ANON_KEY || 'YOUR_SUPABASE_ANON_KEY'
    });
});

// Catch-all route to serve the app for any requested URL (useful for SPA routing)
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
    console.log(`
🚀 WriteRain Server is Live!
🌍 http://localhost:${PORT}
    `);
});
