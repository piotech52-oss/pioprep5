// index.js - COMPLETE WORKING VERSION
const express = require('express');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const app = express();

// ===============================
// SUPABASE CLIENT
// ===============================
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

let dbStatus = { connected: false, type: 'Mock Data' };
let supabase = null;

console.log('🔧 Environment Check:');
console.log(`   SUPABASE_URL: ${supabaseUrl ? 'SET' : 'NOT SET'}`);

if (supabaseUrl && supabaseKey) {
    try {
        supabase = createClient(supabaseUrl, supabaseKey);
        dbStatus.type = 'Supabase PostgreSQL';
        console.log('✅ Supabase client initialized');
        
        (async () => {
            try {
                const { data, error } = await supabase.from('jambuser').select('*').limit(1);
                if (!error) {
                    dbStatus.connected = true;
                    console.log('✅ Database: Connected to Supabase');
                } else {
                    console.log('⚠️ Database error:', error.message);
                }
            } catch (err) {
                console.log('⚠️ Connection failed:', err.message);
            }
        })();
    } catch (error) {
        console.log('⚠️ Supabase error:', error.message);
    }
}

// ===============================
// MIDDLEWARE
// ===============================
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(session({
    secret: process.env.SESSION_SECRET || 'jamb-secret-key-2024',
    resave: false,
    saveUninitialized: false,
    cookie: { 
        secure: false,  // Set to false for local development
        httpOnly: true,
        maxAge: 24 * 60 * 60 * 1000 
    }
}));

// ===============================
// DEBUG - Check what files exist
// ===============================
app.get('/debug-files', (req, res) => {
    const publicDir = path.join(__dirname, 'public');
    const files = {
        'public_exists': fs.existsSync(publicDir),
        'public/index.html': fs.existsSync(path.join(publicDir, 'index.html')),
        'public/home.html': fs.existsSync(path.join(publicDir, 'home.html')),
        'public/homeforall.html': fs.existsSync(path.join(publicDir, 'homeforall.html')),
        'root/home.html': fs.existsSync(path.join(__dirname, 'home.html')),
        'root/homeforall.html': fs.existsSync(path.join(__dirname, 'homeforall.html')),
        '__dirname': __dirname,
        'publicDir': publicDir
    };
    res.json(files);
});

// ===============================
// AUTH ROUTES
// ===============================

app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    console.log(`🔐 Login: ${email}`);
    
    if (!dbStatus.connected || !supabase) {
        // Demo mode
        return res.json({
            success: true,
            message: "Login successful! (Demo)",
            user: { id: 1, userName: "Student", email: email, is_activated: true },
            redirectTo: "/home.html"
        });
    }
    
    try {
        const { data: users, error } = await supabase
            .from('jambuser')
            .select('*')
            .eq('email', email.toLowerCase());
        
        if (error || !users || users.length === 0) {
            return res.status(401).json({ error: "Invalid email or password" });
        }
        
        const user = users[0];
        
        // Password check
        let passwordValid = false;
        try {
            const bcrypt = require('bcrypt');
            passwordValid = await bcrypt.compare(password, user.password);
        } catch (e) {
            passwordValid = (password === user.password);
        }
        
        if (!passwordValid) {
            return res.status(401).json({ error: "Invalid email or password" });
        }
        
        // CRITICAL FIX: Check is_activated value
        const isActivated = user.is_activated === '1' || user.is_activated === 1 || user.is_activated === true;
        
        console.log(`✅ User: ${user.email}, is_activated=${user.is_activated} -> ${isActivated}`);
        
        req.session.userId = user.id;
        req.session.email = user.email;
        req.session.userName = user.userName;
        req.session.isLoggedIn = true;
        req.session.is_activated = isActivated;
        
        const redirectTo = isActivated ? "/home.html" : "/homeforall.html";
        console.log(`📌 Redirecting to: ${redirectTo}`);
        
        return res.json({
            success: true,
            message: "Login successful!",
            user: { id: user.id, userName: user.userName, email: user.email, is_activated: isActivated },
            redirectTo: redirectTo
        });
        
    } catch (error) {
        console.error('Login error:', error);
        return res.status(500).json({ error: "Server error" });
    }
});

app.post('/api/register', async (req, res) => {
    let { userName, email, password } = req.body;
    
    if (!dbStatus.connected || !supabase) {
        return res.status(503).json({ error: "Database unavailable" });
    }
    
    try {
        if (!userName || !email || !password) {
            return res.status(400).json({ error: "All fields required" });
        }
        
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
            return res.status(400).json({ error: "Invalid email format" });
        }
        
        if (password.length < 6) {
            return res.status(400).json({ error: "Password must be at least 6 characters" });
        }
        
        const { data: existing } = await supabase
            .from('jambuser')
            .select('id')
            .eq('email', email.toLowerCase());
        
        if (existing && existing.length > 0) {
            return res.status(400).json({ error: "Email already registered" });
        }
        
        let hashedPassword = password;
        try {
            const bcrypt = require('bcrypt');
            hashedPassword = await bcrypt.hash(password, 10);
        } catch (e) {}
        
        const { error: insertError } = await supabase
            .from('jambuser')
            .insert([{ 
                userName: userName.trim(), 
                email: email.toLowerCase(), 
                password: hashedPassword,
                role: 'student',
                is_activated: '0'
            }]);
        
        if (insertError) {
            return res.status(500).json({ error: "Failed to create account" });
        }
        
        return res.json({ success: true, message: "Registration successful! Please login." });
        
    } catch (error) {
        return res.status(500).json({ error: "Server error" });
    }
});

app.get('/api/session', (req, res) => {
    if (req.session && req.session.isLoggedIn) {
        res.json({
            loggedIn: true,
            user: {
                id: req.session.userId,
                userName: req.session.userName,
                email: req.session.email,
                is_activated: req.session.is_activated === true
            }
        });
    } else {
        res.json({ loggedIn: false });
    }
});

app.post('/api/logout', (req, res) => {
    req.session.destroy(() => {
        res.json({ success: true, message: "Logged out" });
    });
});

// ===============================
// STATIC FILE SERVING - THE FIX
// ===============================

// IMPORTANT: Define specific routes BEFORE the static middleware
app.get('/', (req, res) => {
    const indexPath = path.join(__dirname, 'public', 'index.html');
    if (fs.existsSync(indexPath)) {
        res.sendFile(indexPath);
    } else {
        res.sendFile(path.join(__dirname, 'index.html'));
    }
});

// Explicit route for home.html - THIS IS THE KEY FIX
app.get('/home.html', (req, res) => {
    console.log('📍 Serving home.html request');
    const homePath = path.join(__dirname, 'public', 'home.html');
    const rootHomePath = path.join(__dirname, 'home.html');
    
    if (fs.existsSync(homePath)) {
        console.log('✅ Serving from public/home.html');
        res.sendFile(homePath);
    } else if (fs.existsSync(rootHomePath)) {
        console.log('✅ Serving from root/home.html');
        res.sendFile(rootHomePath);
    } else {
        console.error('❌ home.html not found!');
        res.status(404).send(`
            <h1>home.html not found</h1>
            <p>Please create home.html in your public folder or root directory.</p>
            <p>Current directory: ${__dirname}</p>
            <a href="/">Go to Login</a>
        `);
    }
});

// Explicit route for homeforall.html
app.get('/homeforall.html', (req, res) => {
    console.log('📍 Serving homeforall.html request');
    const homeforallPath = path.join(__dirname, 'public', 'homeforall.html');
    const rootHomeforallPath = path.join(__dirname, 'homeforall.html');
    
    if (fs.existsSync(homeforallPath)) {
        res.sendFile(homeforallPath);
    } else if (fs.existsSync(rootHomeforallPath)) {
        res.sendFile(rootHomeforallPath);
    } else {
        res.status(404).send('homeforall.html not found');
    }
});

// Serve static files from public directory
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(__dirname));

// ===============================
// LOAD OTHER ROUTERS
// ===============================
try {
    const examRouter = require('./server.js');
    app.use('/api', examRouter);
} catch (error) {
    console.log('⚠️ Exam router not loaded');
}

// ===============================
// 404 HANDLER
// ===============================
app.use((req, res) => {
    if (req.path.startsWith('/api')) {
        res.status(404).json({ success: false, message: 'API not found' });
    } else {
        res.status(404).send(`Page ${req.url} not found`);
    }
});

// ===============================
// START SERVER
// ===============================
const PORT = process.env.PORT || 3000;

if (require.main === module) {
    app.listen(PORT, () => {
        console.log('\n' + '='.repeat(60));
        console.log('🎉 SERVER STARTED!');
        console.log('='.repeat(60));
        console.log(`📍 http://localhost:${PORT}`);
        console.log('='.repeat(60));
    });
}

module.exports = app;
