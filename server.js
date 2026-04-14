const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const app = express();
const PORT = process.env.PORT || 3000;

// Basic manual .env loader (since npm install might be unavailable)
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
    const envFile = fs.readFileSync(envPath, 'utf8');
    envFile.split('\n').forEach(line => {
        const [key, ...valueParts] = line.split('=');
        if (key && valueParts.length > 0) {
            process.env[key.trim()] = valueParts.join('=').trim().replace(/(^['"]|['"]$)/g, '');
        }
    });
}

function getLocalIp() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                return iface.address;
            }
        }
    }
    return '0.0.0.0';
}

// Serve static files from the 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

// Securely provide Supabase config to the frontend via Environment Variables
app.get('/api/config', (req, res) => {
    res.json({
        url: process.env.SUPABASE_URL || '',
        key: process.env.SUPABASE_ANON_KEY || ''
    });
});

// Catch-all route to serve the app for any requested URL (useful for SPA routing)
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const LAN_IP = getLocalIp();

app.listen(PORT, '0.0.0.0', () => {
    console.log(`
🚀 WriteRain Server is Live!
🏠 Local:  http://localhost:${PORT}
🌐 Network: http://${LAN_IP}:${PORT}
    `);
});
