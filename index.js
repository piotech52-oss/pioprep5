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
// SUPABASE CLIENT - FIXED
// ===============================
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

let dbStatus = {
    connected: false,
    type: 'Mock Data',
    message: 'Using development database'
};

let supabase = null;

console.log('🔧 Environment Check:');
console.log(`   SUPABASE_URL: ${supabaseUrl ? supabaseUrl : 'NOT SET'}`);
console.log(`   SUPABASE_KEY: ${supabaseKey ? 'SET (length: ' + supabaseKey.length + ')' : 'NOT SET'}`);

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
                    dbStatus.message = 'Connected to live database';
                    console.log('✅ Database: Connected to Supabase');
                    console.log(`   Users found: ${data ? data.length : 0}`);
                } else {
                    console.log('⚠️ Database: Using mock data -', error.message);
                }
            } catch (err) {
                console.log('⚠️ Database: Connection failed -', err.message);
            }
        })();
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

// ===============================
// DEBUG ROUTES
// ===============================

app.get('/api/test-env', (req, res) => {
    res.json({
        success: true,
        supabaseUrl: process.env.SUPABASE_URL,
        supabaseUrlCorrect: process.env.SUPABASE_URL === 'https://vbpehelxdstkasscjiov.supabase.co',
        serviceKeySet: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
        serviceKeyLength: process.env.SUPABASE_SERVICE_ROLE_KEY ? process.env.SUPABASE_SERVICE_ROLE_KEY.length : 0,
        databaseUrlSet: !!process.env.DATABASE_URL,
        nodeEnv: process.env.NODE_ENV,
        sessionSecretSet: !!process.env.SESSION_SECRET
    });
});

app.get('/api/debug-supabase', async (req, res) => {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    
    if (!supabaseUrl || !supabaseKey) {
        return res.json({
            success: false,
            error: 'Missing Supabase credentials',
            hasUrl: !!supabaseUrl,
            hasKey: !!supabaseKey,
            supabaseUrl: supabaseUrl || 'not set',
            supabaseKeyPrefix: supabaseKey ? supabaseKey.substring(0, 20) + '...' : 'not set'
        });
    }
    
    try {
        const { createClient } = require('@supabase/supabase-js');
        const testSupabase = createClient(supabaseUrl, supabaseKey);
        
        const { data, error } = await testSupabase
            .from('jambuser')
            .select('count')
            .limit(1);
        
        res.json({
            success: !error,
            supabaseUrl: supabaseUrl,
            hasKey: true,
            error: error ? error.message : null,
            data: data,
            dbStatusConnected: dbStatus.connected,
            dbStatusType: dbStatus.type,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        res.json({
            success: false,
            error: error.message,
            stack: error.stack
        });
    }
});

app.get('/api/test-query', async (req, res) => {
    if (!supabase) {
        return res.json({
            success: false,
            error: 'Supabase client not initialized',
            dbStatus: dbStatus
        });
    }
    
    try {
        const { data, error } = await supabase
            .from('jambuser')
            .select('*')
            .limit(5);
        
        if (error) {
            return res.json({
                success: false,
                error: error.message,
                details: error
            });
        }
        
        res.json({
            success: true,
            userCount: data ? data.length : 0,
            users: data,
            dbStatus: dbStatus
        });
    } catch (error) {
        res.json({
            success: false,
            error: error.message
        });
    }
});

// ============================================
// FIXED LOGIN ROUTE - Proper is_activated handling
// ============================================
app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    
    console.log(`🔐 Login attempt for: ${email}`);
    
    if (!dbStatus.connected || !supabase) {
        // Demo mode - accept any login with is_activated = true
        console.log('⚠️ Using demo mode');
        return res.json({
            success: true,
            message: "Login successful! (Demo Mode)",
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
        
        // Verify password
        let passwordValid = false;
        try {
            const bcrypt = require('bcrypt');
            passwordValid = await bcrypt.compare(password, user.password);
        } catch (bcryptError) {
            passwordValid = (password === user.password);
        }
        
        if (!passwordValid) {
            return res.status(401).json({ error: "Invalid email or password" });
        }
        
        // FIXED: Check is_activated - handle both string '1' and number 1
        const isActivated = user.is_activated === '1' || user.is_activated === 1 || user.is_activated === true;
        
        console.log(`✅ User found: ${user.email}, is_activated=${user.is_activated} (converted to ${isActivated})`);
        
        req.session.userId = user.id;
        req.session.email = user.email;
        req.session.userName = user.userName;
        req.session.isLoggedIn = true;
        req.session.is_activated = isActivated;
        
        // FIXED: Determine redirect based on is_activated
        const redirectTo = isActivated ? "/home.html" : "/homeforall.html";
        
        console.log(`📌 Redirecting to: ${redirectTo}`);
        
        return res.json({
            success: true,
            message: "Login successful!",
            user: {
                id: user.id,
                userName: user.userName,
                email: user.email,
                is_activated: isActivated
            },
            redirectTo: redirectTo
        });
        
    } catch (error) {
        console.error('Login error:', error);
        return res.status(500).json({ error: "Server error" });
    }
});

// Registration route
app.post('/api/register', async (req, res) => {
    let { userName, email, password } = req.body;

    console.log('📝 Registration attempt:', { userName, email });

    if (!dbStatus.connected || !supabase) {
        return res.status(503).json({ 
            error: "Database is currently unavailable. Please try again later."
        });
    }

    try {
        if (!userName || !email || !password) {
            return res.status(400).json({ error: "All fields are required" });
        }

        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
            return res.status(400).json({ error: "Invalid email format" });
        }

        userName = userName.trim();
        email = email.trim().toLowerCase();
        password = password.trim();

        if (password.length < 6) {
            return res.status(400).json({ error: "Password must be at least 6 characters" });
        }

        const { data: existingUsers, error: checkError } = await supabase
            .from('jambuser')
            .select('id')
            .eq('email', email);

        if (checkError) {
            console.error('Check error:', checkError);
            return res.status(500).json({ error: "Database error: " + checkError.message });
        }

        if (existingUsers && existingUsers.length > 0) {
            return res.status(400).json({ error: "Email already registered" });
        }

        let hashedPassword = password;
        try {
            const bcrypt = require('bcrypt');
            const saltRounds = 10;
            hashedPassword = await bcrypt.hash(password, saltRounds);
            console.log('✅ Password hashed successfully');
        } catch (bcryptError) {
            console.log('bcrypt not available, storing plain password');
        }

        // FIXED: New users get is_activated = '0' (string)
        const { data: newUser, error: insertError } = await supabase
            .from('jambuser')
            .insert([{ 
                userName: userName, 
                email: email, 
                password: hashedPassword,
                role: 'student',
                is_activated: '0'
            }])
            .select();

        if (insertError) {
            console.error('Insert error:', insertError);
            return res.status(500).json({ error: "Failed to create account: " + insertError.message });
        }

        console.log(`✅ New user registered: ${email} with is_activated=0`);
        
        return res.json({
            success: true,
            message: "Registration successful! Please login."
        });

    } catch (error) {
        console.error('Registration error:', error);
        return res.status(500).json({ error: "Server error during registration" });
    }
});

// Session check - FIXED to return correct is_activated
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
// SERVE STATIC FILES - FIXED ORDER
// ===============================

// First, serve specific HTML files directly
const publicDir = path.join(__dirname, 'public');
const staticFiles = ['home.html', 'homeforall.html', 'index.html', 'admin-dashboard.html'];

staticFiles.forEach(file => {
    const filePath = path.join(publicDir, file);
    if (fs.existsSync(filePath)) {
        console.log(`✅ Found: ${file}`);
    } else {
        console.log(`⚠️ Missing: ${file} in ${publicDir}`);
    }
});

// Serve static files from public directory
app.use(express.static(publicDir));
app.use(express.static(__dirname));

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
// HTML ROUTES - FIXED
// ===============================

// Root route - serve index.html (login page)
app.get('/', (req, res) => {
    const indexPath = path.join(publicDir, 'index.html');
    if (fs.existsSync(indexPath)) {
        res.sendFile(indexPath);
    } else {
        res.send('index.html not found');
    }
});

// Serve home.html for activated users
app.get('/home.html', (req, res) => {
    const homePath = path.join(publicDir, 'home.html');
    if (fs.existsSync(homePath)) {
        res.sendFile(homePath);
    } else {
        console.error('home.html not found at:', homePath);
        res.status(404).send('home.html not found. Please create this file.');
    }
});

// Serve homeforall.html for non-activated users
app.get('/homeforall.html', (req, res) => {
    const homeforallPath = path.join(publicDir, 'homeforall.html');
    if (fs.existsSync(homeforallPath)) {
        res.sendFile(homeforallPath);
    } else {
        console.error('homeforall.html not found at:', homeforallPath);
        res.status(404).send('homeforall.html not found. Please create this file.');
    }
});

// Generic handler for other HTML files
app.get('/:page.html', (req, res) => {
    const filePath = path.join(publicDir, `${req.params.page}.html`);
    const rootPath = path.join(__dirname, `${req.params.page}.html`);
    
    if (fs.existsSync(filePath)) {
        res.sendFile(filePath);
    } else if (fs.existsSync(rootPath)) {
        res.sendFile(rootPath);
    } else {
        res.status(404).send(`Page ${req.params.page}.html not found`);
    }
});

// ===============================
// 404 HANDLER
// ===============================
app.use((req, res) => {
    if (req.path.startsWith('/api')) {
        res.status(404).json({ success: false, message: 'API route not found' });
    } else {
        res.status(404).send('Page not found');
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
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
        console.log('\n' + '='.repeat(60));
        console.log('🎉 JAMB CBT SYSTEM STARTED SUCCESSFULLY!');
        console.log('='.repeat(60));
        console.log(`📍 URL: http://localhost:${PORT}`);
        console.log(`📊 Database: ${dbStatus.type}`);
        console.log('='.repeat(60));
        console.log('\n📄 Available Pages:');
        console.log(`   • /           - Login page (index.html)`);
        console.log(`   • /home.html  - Activated user dashboard`);
        console.log(`   • /homeforall.html - Non-activated user page`);
        console.log('='.repeat(60) + '\n');
    });
}
