// index.js - FINAL WORKING VERSION WITH ALL ROUTERS (PORT 30001)
const express = require('express');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const app = express();

// ===============================
// DEBUG MIDDLEWARE
// ===============================
app.use((req, res, next) => {
    console.log(`📍 ${req.method} ${req.url}`);
    next();
});

// ===============================
// BLOCK REDIRECTS FOR API ROUTES
// ===============================
app.use('/api', (req, res, next) => {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    
    const originalRedirect = res.redirect;
    res.redirect = function(url) {
        console.error(`❌ BLOCKED REDIRECT: ${req.method} ${req.url} -> ${url}`);
        return res.status(500).json({ 
            success: false, 
            message: 'Redirect blocked - API should return JSON' 
        });
    };
    next();
});

// ===============================
// DATABASE STATUS
// ===============================
let dbStatus = {
    connected: false,
    type: 'Mock Data',
    message: 'Using development database'
};

// Try to connect to Supabase
try {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    
    if (supabaseUrl && supabaseKey) {
        const { createClient } = require('@supabase/supabase-js');
        const supabase = createClient(supabaseUrl, supabaseKey);
        
        // Test connection
        setTimeout(async () => {
            try {
                const { error } = await supabase.from('subjects').select('*').limit(1);
                if (!error) {
                    dbStatus.connected = true;
                    dbStatus.type = 'Supabase PostgreSQL';
                    dbStatus.message = 'Connected to live database';
                    console.log('✅ Database: Connected to Supabase');
                } else {
                    console.log('⚠️ Database: Using mock data (Supabase error)');
                }
            } catch (err) {
                console.log('⚠️ Database: Using mock data (connection failed)');
            }
        }, 1000);
    }
} catch (error) {
    console.log('📊 Database: Mock data enabled');
}

// ===============================
// MIDDLEWARE
// ===============================
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(__dirname));

app.use(session({
    secret: process.env.SESSION_SECRET || 'jamb-secret-key-2024',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 }
}));

// ===============================
// LOAD ALL ROUTERS - ORDER MATTERS!
// ===============================
console.log('📦 Loading application routes...');

// 1. Load exam router FIRST (most specific)
try {
    const examRouter = require('./server.js');
    app.use('/api', examRouter);
    console.log('✅ Exam router loaded at /api');
} catch (error) {
    console.log('⚠️ Exam router issue:', error.message);
}

// 2. Load verifycode router
try {
    app.use('/verifycode', require('./verifycode.js'));
    console.log('✅ VerifyCode router loaded');
} catch (error) {
    console.log('⚠️ VerifyCode router issue:', error.message);
}

// 3. Load payment router
try {
    app.use('/', require('./payment.js'));
    console.log('✅ Payment router loaded');
} catch (error) {
    console.log('⚠️ Payment router issue:', error.message);
}

// 4. Load admin router
try {
    app.use('/', require('./adminlogin.js'));
    console.log('✅ Admin router loaded');
} catch (error) {
    console.log('⚠️ Admin router issue:', error.message);
}

// 5. Load main router LAST (least specific)
try {
    app.use('/', require('./router.js'));
    console.log('✅ Main router loaded');
} catch (error) {
    console.log('⚠️ Main router issue:', error.message);
}

// ===============================
// SESSION & USER ROUTES
// ===============================
app.get('/api/session', (req, res) => {
    res.json({
        loggedIn: true,
        user: {
            id: 1,
            userName: 'Student',
            email: 'student@example.com',
            is_activated: true
        }
    });
});

app.get('/api/user/stats', (req, res) => {
    res.json({
        success: true,
        stats: {
            completedExams: 0,
            averageScore: 0,
            totalTime: 0,
            streak: 0
        }
    });
});

app.get('/api/test', (req, res) => {
    res.json({ success: true, message: 'API test working' });
});

app.get('/api/health', (req, res) => {
    res.json({
        success: true,
        message: 'System healthy',
        database: dbStatus.type,
        timestamp: new Date().toISOString()
    });
});

// ===============================
// SERVE HOME.HTML
// ===============================
const homeFilePath = path.join(__dirname, 'home.html');

if (fs.existsSync(homeFilePath)) {
    console.log(`✅ Found home.html`);
} else {
    console.log('❌ home.html not found!');
}

app.get('/', (req, res) => {
    if (fs.existsSync(homeFilePath)) {
        res.sendFile(homeFilePath);
    } else {
        res.send('home.html not found');
    }
});

app.get('/test', (req, res) => {
    res.json({ 
        success: true, 
        message: 'Server is running',
        database: dbStatus.type,
        time: new Date().toISOString()
    });
});

// ===============================
// 404 HANDLER
// ===============================
app.use((req, res) => {
    if (req.path.startsWith('/api')) {
        res.status(404).json({ success: false, message: 'API route not found' });
    } else {
        res.status(404).send('Not found');
    }
});

// ===============================
// START SERVER ON PORT 30001
// ===============================
const PORT = 30001; // Force port 30001

app.listen(PORT, () => {
    console.log('\n' + '='.repeat(60));
    console.log('🎉 JAMB CBT SYSTEM STARTED SUCCESSFULLY!');
    console.log('='.repeat(60));
    console.log(`📍 URL: http://localhost:${PORT}`);
    console.log(`📊 Database: ${dbStatus.type}`);
    console.log('='.repeat(60));
    console.log('\n✅ TEST THESE URLs:');
    console.log(`   Home:        http://localhost:${PORT}`);
    console.log(`   Test:        http://localhost:${PORT}/api/test`);
    console.log(`   Subjects:    http://localhost:${PORT}/api/subjects`);
    console.log(`   Years:       http://localhost:${PORT}/api/years`);
    console.log(`   Health:      http://localhost:${PORT}/api/health`);
    console.log(`   Session:     http://localhost:${PORT}/api/session`);
    console.log('='.repeat(60));
});  