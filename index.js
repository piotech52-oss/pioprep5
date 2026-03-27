// index.js - COMPLETE WORKING VERSION WITH POSTGRESQL
const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const session = require('express-session');
const connectPgSimple = require('connect-pg-simple');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const app = express();

// =========================
// MIDDLEWARE CONFIGURATION
// =========================

app.use(cors({
    origin: process.env.NODE_ENV === 'production' 
        ? 'https://pioprep5-olwj.vercel.app'
        : 'http://localhost:3000',
    credentials: true
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(__dirname));

// =========================
// POSTGRESQL CONFIGURATION (Supabase)
// =========================

function encodeDatabaseUrl(url) {
    if (!url) return url;
    return url.replace(/:(.*?)@/, (match, p1) => {
        if (p1.includes('@') || p1.includes('#') || p1.includes('!')) {
            return ':' + encodeURIComponent(p1) + '@';
        }
        return match;
    });
}

const databaseUrl = encodeDatabaseUrl(process.env.DATABASE_URL);

console.log('📊 DATABASE_URL is set:', !!databaseUrl);

const pool = new Pool({
    connectionString: databaseUrl,
    ssl: {
        rejectUnauthorized: false,
        sslmode: 'require'
    },
    max: 1,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
});

let dbConnected = false;
let connectionChecked = false;

async function testDatabaseConnection() {
    try {
        const client = await pool.connect();
        console.log('✅ Connected to Supabase PostgreSQL!');
        dbConnected = true;
        connectionChecked = true;
        client.release();
        await client.query('SELECT 1');
        console.log('✅ Database queries working');
        
        // Initialize tables
        await initializeDatabase();
        return true;
    } catch (err) {
        console.error('❌ Error connecting to Supabase:', err.message);
        dbConnected = false;
        connectionChecked = true;
        return false;
    }
}

testDatabaseConnection();
setInterval(testDatabaseConnection, 30000);

app.use((req, res, next) => {
    req.dbConnected = dbConnected;
    req.connectionChecked = connectionChecked;
    next();
});

// =========================
// SESSION CONFIGURATION
// =========================

let sessionStore;
try {
    const PgSession = connectPgSimple(session);
    if (dbConnected) {
        sessionStore = new PgSession({
            pool: pool,
            tableName: 'user_sessions',
            createTableIfMissing: true
        });
    }
} catch (error) {
    console.log('⚠️ Session store using memory');
}

app.use(session({
    store: sessionStore,
    secret: process.env.SESSION_SECRET || 'jamb-secret-key-2024',
    resave: false,
    saveUninitialized: false,
    cookie: {
        maxAge: 7 * 24 * 60 * 60 * 1000,
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax'
    }
}));

// =========================
// DATABASE INITIALIZATION
// =========================

async function initializeDatabase() {
    if (!dbConnected) return;
    
    try {
        const result = await pool.query(`
            SELECT EXISTS (
                SELECT FROM information_schema.tables 
                WHERE table_name = 'jambuser'
            );
        `);
        
        if (!result.rows[0].exists) {
            console.log('📝 Creating jambuser table...');
            await pool.query(`
                CREATE TABLE jambuser (
                    id SERIAL PRIMARY KEY,
                    "userName" VARCHAR(100) NOT NULL,
                    email VARCHAR(255) NOT NULL UNIQUE,
                    password VARCHAR(255) NOT NULL,
                    role VARCHAR(50) DEFAULT 'student',
                    is_activated VARCHAR(1) DEFAULT '0',
                    "activationCode" VARCHAR(10),
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                );
            `);
            console.log('✅ jambuser table created');
        } else {
            const countResult = await pool.query("SELECT COUNT(*) as count FROM jambuser");
            console.log(`📊 Database has ${countResult.rows[0].count} existing users`);
        }
        
        const sessionTable = await pool.query(`
            SELECT EXISTS (
                SELECT FROM information_schema.tables 
                WHERE table_name = 'user_sessions'
            );
        `);
        
        if (!sessionTable.rows[0].exists) {
            await pool.query(`
                CREATE TABLE user_sessions (
                    sid VARCHAR NOT NULL PRIMARY KEY,
                    sess JSON NOT NULL,
                    expire TIMESTAMP NOT NULL
                );
            `);
            console.log('✅ user_sessions table created');
        }
        
    } catch (error) {
        console.error('❌ Database initialization error:', error.message);
    }
}

// =========================
// UTILITY FUNCTIONS
// =========================

function isRealisticEmail(email) {
    if (!email) return false;
    email = email.trim().toLowerCase();
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) return false;
    if (email.includes("..")) return false;
    if (email.length < 6) return false;
    const tldRegex = /\.(com|net|org|edu|gov|io|ng|co|info|biz|me|tech)$/;
    if (!tldRegex.test(email)) return false;
    return true;
}

const requireLogin = (req, res, next) => {
    if (!req.session || !req.session.isLoggedIn) {
        return res.status(401).json({ error: 'Please login first' });
    }
    next();
};

// =========================
// API ROUTES
// =========================

// Health check
app.get('/api/health', async (req, res) => {
    const status = {
        status: 'healthy',
        timestamp: new Date().toISOString(),
        service: 'JAMB CBT Authentication',
        environment: process.env.NODE_ENV || 'development',
        database: {
            connected: dbConnected,
            type: 'Supabase PostgreSQL',
            checked: connectionChecked
        }
    };
    
    if (dbConnected) {
        try {
            const dbTest = await pool.query('SELECT NOW() as time');
            status.database.time = dbTest.rows[0].time;
        } catch (error) {
            status.database.error = error.message;
        }
    }
    
    res.json(status);
});

// Debug database connection
app.get('/api/debug-db', async (req, res) => {
    if (!dbConnected) {
        return res.json({
            success: false,
            message: 'Database not connected',
            dbConnected: false,
            databaseUrlSet: !!process.env.DATABASE_URL
        });
    }
    
    try {
        const result = await pool.query('SELECT NOW() as time, COUNT(*) as user_count FROM jambuser');
        res.json({
            success: true,
            message: 'Database connected!',
            time: result.rows[0].time,
            userCount: result.rows[0].user_count,
            dbConnected: true
        });
    } catch (error) {
        res.json({
            success: false,
            message: 'Database query failed',
            error: error.message,
            dbConnected: dbConnected
        });
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
                is_activated: req.session.is_activated
            }
        });
    } else {
        res.json({ loggedIn: false });
    }
});

// Register user
app.post('/api/register', async (req, res) => {
    let { userName, email, password } = req.body;

    console.log('📝 Registration attempt:', { userName, email });

    if (!dbConnected) {
        return res.status(503).json({ 
            error: "Database is currently unavailable. Please try again later."
        });
    }

    try {
        if (!userName || !email || !password) {
            return res.status(400).json({ error: "All fields are required" });
        }

        if (!isRealisticEmail(email)) {
            return res.status(400).json({ error: "Invalid email format" });
        }

        userName = userName.trim();
        email = email.trim().toLowerCase();
        password = password.trim();

        if (password.length < 6) {
            return res.status(400).json({ error: "Password must be at least 6 characters" });
        }

        const existingUsers = await pool.query(
            "SELECT id FROM jambuser WHERE email = $1",
            [email]
        );

        if (existingUsers.rows.length > 0) {
            return res.status(400).json({ error: "Email already registered" });
        }

        const saltRounds = 10;
        const hashedPassword = await bcrypt.hash(password, saltRounds);

        const result = await pool.query(
            "INSERT INTO jambuser (\"userName\", email, password, role, is_activated) VALUES ($1, $2, $3, $4, $5) RETURNING id, \"userName\", email",
            [userName, email, hashedPassword, 'student', '0']
        );

        console.log(`✅ New user registered: ${email}`);
        
        return res.json({
            success: true,
            message: "Registration successful! Please login."
        });

    } catch (error) {
        console.error('Registration error:', error.message);
        if (error.code === '23505') {
            return res.status(400).json({ error: "Email already registered" });
        }
        return res.status(500).json({ error: "Server error during registration" });
    }
});

// Login user
app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;

    console.log(`🔐 Login attempt for: ${email}`);

    if (!dbConnected) {
        return res.status(503).json({ 
            error: "Database is currently unavailable. Please try again later."
        });
    }

    try {
        if (!email || !password) {
            return res.status(400).json({ error: "Email and password are required" });
        }

        const cleanEmail = email.trim().toLowerCase();
        
        const userResult = await pool.query(
            "SELECT * FROM jambuser WHERE email = $1",
            [cleanEmail]
        );

        if (userResult.rows.length === 0) {
            return res.status(401).json({ error: "Invalid email or password" });
        }

        const user = userResult.rows[0];
        
        const isMatch = await bcrypt.compare(password, user.password);
        
        if (!isMatch) {
            return res.status(401).json({ error: "Invalid email or password" });
        }

        const isActivated = user.is_activated === '1';

        req.session.userId = user.id;
        req.session.email = user.email;
        req.session.userName = user.userName;
        req.session.isLoggedIn = true;
        req.session.is_activated = user.is_activated;

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
        console.error('Login error:', error.message);
        return res.status(500).json({ error: "Server error during authentication" });
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

// =========================
// SERVE HTML FILES
// =========================

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

// =========================
// 404 HANDLER
// =========================
app.use((req, res) => {
    if (req.path.startsWith('/api')) {
        res.status(404).json({ success: false, message: 'API route not found' });
    } else {
        res.status(404).send('Page not found');
    }
});

// =========================
// ERROR HANDLER
// =========================
app.use((err, req, res, next) => {
    console.error('❌ Server error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
});

// =========================
// EXPORT FOR VERCEL
// =========================
module.exports = app;

// =========================
// LOCAL DEVELOPMENT
// =========================
if (require.main === module) {
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
        console.log('\n' + '='.repeat(50));
        console.log('🎯 JAMB CBT System Started!');
        console.log('='.repeat(50));
        console.log(`📍 http://localhost:${PORT}`);
        console.log(`📊 Database: ${dbConnected ? '✅ Connected' : '❌ Disconnected'}`);
        console.log('='.repeat(50));
    });
}
