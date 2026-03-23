// index.js - MINIMAL TEST VERSION
const express = require('express');
const { Pool } = require('pg');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const app = express();

// Middleware
app.use(express.json());
app.use(express.static(__dirname));

// Simple database connection
const databaseUrl = process.env.DATABASE_URL;
console.log('DATABASE_URL exists:', !!databaseUrl);

const pool = new Pool({
    connectionString: databaseUrl,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 5000
});

let dbConnected = false;

// Test connection
pool.connect((err, client, release) => {
    if (err) {
        console.error('❌ Database connection error:', err.message);
        dbConnected = false;
    } else {
        console.log('✅ Database connected!');
        dbConnected = true;
        release();
    }
});

// Test endpoint
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        dbConnected: dbConnected,
        databaseUrlSet: !!databaseUrl,
        timestamp: new Date().toISOString()
    });
});

// Debug database endpoint
app.get('/api/debug-db', async (req, res) => {
    if (!dbConnected) {
        return res.json({
            success: false,
            message: 'Database not connected',
            dbConnected: false
        });
    }
    
    try {
        const result = await pool.query('SELECT NOW() as time');
        res.json({
            success: true,
            message: 'Database connected!',
            time: result.rows[0].time
        });
    } catch (error) {
        res.json({
            success: false,
            error: error.message
        });
    }
});

// Simple login test
app.post('/api/login', (req, res) => {
    res.json({
        success: true,
        message: "Login successful!",
        user: { is_activated: true },
        redirectTo: "/home.html"
    });
});

// Serve HTML
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'login.html'));
});

app.get('/:page.html', (req, res) => {
    const filePath = path.join(__dirname, `${req.params.page}.html`);
    if (fs.existsSync(filePath)) {
        res.sendFile(filePath);
    } else {
        res.status(404).send('Page not found');
    }
});

module.exports = app;

if (require.main === module) {
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
        console.log(`🚀 Server running on port ${PORT}`);
    });
}
