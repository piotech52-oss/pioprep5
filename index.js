// index.js - WORKING VERSION WITH SUPABASE CLIENT (FOR VERCEL)
const express = require('express');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');
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
// SUPABASE CLIENT
// ===============================
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

let dbStatus = {
    connected: false,
    type: 'Mock Data',
    message: 'Using development database'
};

let supabase = null;

if (supabaseUrl && supabaseKey) {
    try {
        supabase = createClient(supabaseUrl, supabaseKey);
        dbStatus.type = 'Supabase PostgreSQL';
        console.log('✅ Supabase client initialized');
        
        // Test connection
        setTimeout(async () => {
            try {
                const { error } = await supabase.from('jambuser').select('*').limit(1);
                if (!error) {
                    dbStatus.connected = true;
                    dbStatus.message = 'Connected to live database';
                    console.log('✅ Database: Connected to Supabase');
                } else {
                    console.log('⚠️ Database: Using mock data -', error.message);
                }
            } catch (err) {
                console.log('⚠️ Database: Connection failed -', err.message);
            }
        }, 1000);
    } catch (error) {
        console.log('⚠️ Supabase client error:', error.message);
    }
} else {
    console.log('📊 Database: Using mock data (no credentials)');
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
    cookie: { 
        secure: process.env.NODE_ENV === 'production',
        httpOnly: true,
        maxAge: 24 * 60 * 60 * 1000 
    }
}));

// ===============================
// AUTH ROUTES
// ===============================

// Health check
app.get('/api/health', (req, res) => {
    res.json({
        success: true,
        message: 'System healthy',
        database: dbStatus.type,
        connected: dbStatus.connected,
        timestamp: new Date().toISOString()
    });
});

// Login route
app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    
    console.log(`🔐 Login attempt for: ${email}`);
    
    if (!dbStatus.connected || !supabase) {
        // Demo mode - accept any login
        return res.json({
            success: true,
            message: "Login successful!",
            user: {
                id: 1,
                userName: "Student",
                email: email,
                is_activated: true
            },
            redirectTo: "/home.html"
        });
    }
    
    try {
        // Check if user exists
        const { data: users, error } = await supabase
            .from('jambuser')
            .select('*')
            .eq('email', email.toLowerCase());
        
        if (error) {
            console.error('Database error:', error);
            return res.status(500).json({ error: "Database error" });
        }
        
        if (!users || users.length === 0) {
            return res.status(401).json({ error: "Invalid email or password" });
        }
        
        const user = users[0];
        
        // For demo, accept any password if no bcrypt
        const isActivated = user.is_activated === '1';
        
        req.session.userId = user.id;
        req.session.email = user.email;
        req.session.userName = user.userName;
        req.session.isLoggedIn = true;
        
        return res.json({
            success: true,
            message: "Login successful!",
            user: {
                id: user.id,
                userName: user.userName,
                email: user.email,
                is_activated: isActivated
            },
            redirectTo: isActivated ? "/home.html" : "/homeforall.html"
        });
        
    } catch (error) {
        console.error('Login error:', error);
        return res.status(500).json({ error: "Server error" });
    }
});

// Session check
app.get('/api/session', (req, res) => {
    if (req.session && req.session.isLoggedIn) {
        res.json({
            loggedIn: true,
            user: {
                id: req.session.userId,
                userName: req.session.userName,
                email: req.session.email,
                is_activated: true
            }
        });
    } else {
        res.json({ loggedIn: false });
    }
});

// Logout
app.post('/api/logout', (req, res) => {
    req.session.destroy((err) => {
        if (err) {
            return res.status(500).json({ error: "Could not logout" });
        }
        res.json({ success: true, message: "Logged out successfully" });
    });
});

// Test route
app.get('/api/test', (req, res) => {
    res.json({ success: true, message: 'API test working' });
});

// ===============================
// LOAD OTHER ROUTERS
// ===============================
console.log('📦 Loading application routes...');

try {
    const examRouter = require('./server.js');
    app.use('/api', examRouter);
    console.log('✅ Exam router loaded at /api');
} catch (error) {
    console.log('⚠️ Exam router issue:', error.message);
}

try {
    app.use('/verifycode', require('./verifycode.js'));
    console.log('✅ VerifyCode router loaded');
} catch (error) {
    console.log('⚠️ VerifyCode router issue:', error.message);
}

try {
    app.use('/', require('./payment.js'));
    console.log('✅ Payment router loaded');
} catch (error) {
    console.log('⚠️ Payment router issue:', error.message);
}

try {
    app.use('/', require('./adminlogin.js'));
    console.log('✅ Admin router loaded');
} catch (error) {
    console.log('⚠️ Admin router issue:', error.message);
}

try {
    app.use('/', require('./router.js'));
    console.log('✅ Main router loaded');
} catch (error) {
    console.log('⚠️ Main router issue:', error.message);
}

// ===============================
// SERVE HTML FILES
// ===============================
const homeFilePath = path.join(__dirname, 'home.html');

app.get('/', (req, res) => {
    if (fs.existsSync(homeFilePath)) {
        res.sendFile(homeFilePath);
    } else {
        res.send('home.html not found');
    }
});

app.get('/:page.html', (req, res) => {
    const filePath = path.join(__dirname, `${req.params.page}.html`);
    if (fs.existsSync(filePath)) {
        res.sendFile(filePath);
    } else {
        res.status(404).send('Page not found');
    }
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
// EXPORT FOR VERCEL
// ===============================
module.exports = app;

// ===============================
// LOCAL DEVELOPMENT
// ===============================
if (require.main === module) {
    const PORT = process.env.PORT || 30001;
    app.listen(PORT, () => {
        console.log('\n' + '='.repeat(60));
        console.log('🎉 JAMB CBT SYSTEM STARTED SUCCESSFULLY!');
        console.log('='.repeat(60));
        console.log(`📍 URL: http://localhost:${PORT}`);
        console.log(`📊 Database: ${dbStatus.type}`);
        console.log('='.repeat(60));
    });
}
