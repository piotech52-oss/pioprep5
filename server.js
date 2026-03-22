// server.js - JAMB CBT Exam Router (Supabase PostgreSQL Version with Local Image Support)
const express = require('express');
const router = express.Router();
const { Pool } = require('pg');
const path = require('path');
const fs = require('fs');

// ===============================
// SUPABASE POSTGRESQL CONNECTION
// ===============================
const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://postgres.vbpehelxdstkasscjiov:6AEm4AvvZPgEkpSx@aws-1-eu-west-1.pooler.supabase.com:6543/postgres',
    ssl: {
        rejectUnauthorized: false,
        sslmode: 'require'
    },
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
});

// Global connection status
let dbConnected = false;
let connectionChecked = false;

// Test database connection
async function testDatabaseConnection() {
    try {
        const client = await pool.connect();
        console.log('✅ Exam DB connected to Supabase PostgreSQL!');
        dbConnected = true;
        connectionChecked = true;
        client.release();
        
        // Test a simple query
        await client.query('SELECT 1');
        console.log('✅ Exam database queries working');
        
        return true;
    } catch (err) {
        console.error('❌ Error connecting exam to Supabase PostgreSQL:', err.message);
        dbConnected = false;
        connectionChecked = true;
        return false;
    }
}

// Test connection immediately
testDatabaseConnection();

// Retry connection every 30 seconds
setInterval(testDatabaseConnection, 30000);

// Middleware to check database status
router.use((req, res, next) => {
    req.dbConnected = dbConnected;
    req.connectionChecked = connectionChecked;
    next();
});

// ================================
// HELPER FUNCTION FOR SAFE QUERIES
// ================================
async function safeQuery(query, params = []) {
    try {
        const result = await pool.query(query, params);
        return { success: true, data: result.rows };
    } catch (error) {
        console.error('Database query error:', {
            query: query.substring(0, 100),
            params,
            error: error.message
        });
        return { success: false, error: error.message };
    }
}

// ================================
// MIDDLEWARE TO CHECK USER LOGIN
// ================================
const requireLogin = (req, res, next) => {
    if (!req.session || !req.session.userId) {
        return res.status(401).json({ error: 'Please login first' });
    }
    next();
};

// ================================
// SESSION ENDPOINT
// ================================
router.get('/session', (req, res) => {
    if (req.session && req.session.userId) {
        res.json({
            loggedIn: true,
            user: {
                id: req.session.userId,
                userName: req.session.userName || req.session.name || 'User',
                email: req.session.userEmail || req.session.email,
                is_activated: req.session.is_activated || false
            }
        });
    } else {
        res.json({ loggedIn: false });
    }
});

// ================================
// USER STATS ENDPOINT
// ================================
router.get('/user/stats', requireLogin, async (req, res) => {
    if (!dbConnected) {
        // Return mock stats if database not connected
        return res.json({
            success: true,
            stats: {
                completedExams: 0,
                averageScore: 0,
                totalTime: 0,
                streak: 0
            }
        });
    }
    
    try {
        // Check if exam_results table exists
        const tableCheck = await pool.query(`
            SELECT EXISTS (
                SELECT FROM information_schema.tables 
                WHERE table_schema = 'public' 
                AND table_name = 'exam_results'
            )
        `);
        
        if (!tableCheck.rows[0].exists) {
            // Return default stats if table doesn't exist
            return res.json({
                success: true,
                stats: {
                    completedExams: 0,
                    averageScore: 0,
                    totalTime: 0,
                    streak: 0
                }
            });
        }
        
        // Get user's exam history from database
        const result = await pool.query(
            `SELECT 
                COUNT(*) as completed_exams,
                COALESCE(AVG(score), 0) as avg_score,
                COALESCE(SUM(duration), 0) as total_time
            FROM exam_results 
            WHERE user_id = $1`,
            [req.session.userId]
        );
        
        const stats = {
            completedExams: parseInt(result.rows[0].completed_exams) || 0,
            averageScore: Math.round(parseFloat(result.rows[0].avg_score)) || 0,
            totalTime: parseInt(result.rows[0].total_time) || 0,
            streak: 0
        };
        
        res.json({
            success: true,
            stats: stats
        });
    } catch (error) {
        console.error('Error fetching user stats:', error);
        res.json({
            success: true,
            stats: {
                completedExams: 0,
                averageScore: 0,
                totalTime: 0,
                streak: 0
            }
        });
    }
});

// Test database connection route
router.get('/test-connection', async (req, res) => {
    try {
        const result = await pool.query('SELECT NOW() as time');
        res.json({
            success: true,
            message: 'Database connected',
            time: result.rows[0].time,
            environment: process.env.NODE_ENV || 'development',
            dbConnected: dbConnected
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: 'Database connection failed',
            error: error.message
        });
    }
});

// Subject mapping to table names
const SUBJECT_TABLES = {
    'BIO': 'bio_questions',
    'PHY': 'phy_questions',
    'CHEM': 'chem_questions',
    'MATH': 'math_questions',
    'ENG': 'eng_questions',
    'GOV': 'gov_questions',
    'ECO': 'eco_questions',
    'GEO': 'geo_questions',
    'CRS': 'crs_questions',
    'IRS': 'irs_questions',
    'LIT': 'lit_questions',
    'COMM': 'comm_questions',
    'ACCT': 'acct_questions',
    'AGRIC': 'agric_questions',
    'HIST': 'hist_questions',
    'FRENCH': 'french_questions',
    'ICT': 'itc_questions',
    'HE_CON': 'h_e_con_questions'
};

// Subject full names
const SUBJECT_NAMES = {
    'BIO': 'Biology',
    'PHY': 'Physics',
    'CHEM': 'Chemistry',
    'MATH': 'Mathematics',
    'ENG': 'English Language',
    'GOV': 'Government',
    'ECO': 'Economics',
    'GEO': 'Geography',
    'CRS': 'Christian Religious Studies',
    'IRS': 'Islamic Religious Studies',
    'LIT': 'Literature',
    'COMM': 'Commerce',
    'ACCT': 'Accounting',
    'AGRIC': 'Agricultural Science',
    'HIST': 'History',
    'FRENCH': 'French',
    'ICT': 'ICT/Computer Studies',
    'HE_CON': 'Home Economics'
};

// Subject icons
const SUBJECT_ICONS = {
    'BIO': 'fa-dna',
    'PHY': 'fa-atom',
    'CHEM': 'fa-flask',
    'MATH': 'fa-calculator',
    'ENG': 'fa-language',
    'GOV': 'fa-landmark',
    'ECO': 'fa-chart-line',
    'GEO': 'fa-globe-africa',
    'CRS': 'fa-church',
    'IRS': 'fa-mosque',
    'LIT': 'fas fa-book-open',
    'COMM': 'fas fa-shopping-cart',
    'ACCT': 'fas fa-balance-scale',
    'AGRIC': 'fas fa-tractor',
    'HIST': 'fa-history',
    'FRENCH': 'fa-language',
    'ICT': 'fa-laptop',
    'HE_CON': 'fa-home'
};

// Question limits
const QUESTION_LIMITS = {
    'ENG': 60,
    'DEFAULT': 40
};

// ============================
// PUBLIC API ROUTES
// ============================

// GET ALL SUBJECTS
router.get('/subjects', (req, res) => {
    try {
        const subjects = Object.keys(SUBJECT_TABLES).map(code => ({
            subject_code: code,
            subject_name: SUBJECT_NAMES[code] || code,
            icon: SUBJECT_ICONS[code] || 'fa-book'
        }));
        
        res.json({ 
            success: true, 
            subjects: subjects 
        });
    } catch (error) {
        res.status(500).json({ 
            success: false, 
            message: 'Server error' 
        });
    }
});

// GET YEARS FROM SUBJECT TABLES
router.get('/years', async (req, res) => {
    if (!dbConnected) {
        const defaultYears = [];
        for (let year = 2024; year >= 2001; year--) {
            defaultYears.push(year.toString());
        }
        return res.json({ success: true, years: defaultYears });
    }
    
    try {
        const allYears = [];
        
        for (const [subjectCode, tableName] of Object.entries(SUBJECT_TABLES)) {
            try {
                const tableExists = await pool.query(
                    `SELECT EXISTS (
                        SELECT FROM information_schema.tables 
                        WHERE table_schema = 'public' 
                        AND table_name = $1
                    )`,
                    [tableName]
                );
                
                if (!tableExists.rows[0].exists) {
                    console.log(`Table ${tableName} does not exist`);
                    continue;
                }
                
                const query = `SELECT DISTINCT year FROM ${tableName} WHERE year IS NOT NULL ORDER BY year DESC`;
                const result = await pool.query(query);
                
                const years = result.rows.map(row => row.year).filter(year => year);
                allYears.push(...years);
            } catch (error) {
                console.log(`Error fetching years from ${tableName}:`, error.message);
                continue;
            }
        }
        
        const uniqueYears = [...new Set(allYears)]
            .filter(year => year)
            .sort((a, b) => b - a)
            .map(year => year.toString());
        
        if (uniqueYears.length === 0) {
            const years = [];
            for (let year = 2024; year >= 2001; year--) {
                years.push(year.toString());
            }
            return res.json({ success: true, years: years });
        }
        
        res.json({ success: true, years: uniqueYears });
    } catch (error) {
        console.error('Error fetching years:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Database error' 
        });
    }
});

// GET QUESTION COUNT FOR SELECTED SUBJECTS AND YEAR
router.post('/question-count', async (req, res) => {
    const { subjects, year } = req.body;
    
    if (!subjects || !Array.isArray(subjects) || subjects.length === 0 || !year) {
        return res.status(400).json({ 
            success: false, 
            message: 'Subjects and year are required' 
        });
    }
    
    if (!dbConnected) {
        // Return mock counts
        const counts = subjects.map(subjectCode => ({
            subject: subjectCode,
            subject_name: SUBJECT_NAMES[subjectCode] || subjectCode,
            count: subjectCode === 'ENG' ? 60 : 40
        }));
        return res.json({ success: true, counts, total: counts.reduce((sum, item) => sum + item.count, 0) });
    }
    
    try {
        const counts = [];
        
        for (const subjectCode of subjects) {
            const tableName = SUBJECT_TABLES[subjectCode];
            if (!tableName) continue;
            
            try {
                const result = await pool.query(
                    `SELECT COUNT(*) as count FROM ${tableName} WHERE year = $1`,
                    [year]
                );
                
                counts.push({
                    subject: subjectCode,
                    subject_name: SUBJECT_NAMES[subjectCode] || subjectCode,
                    count: parseInt(result.rows[0].count)
                });
            } catch (error) {
                console.error(`Error counting ${subjectCode}:`, error.message);
                counts.push({
                    subject: subjectCode,
                    subject_name: SUBJECT_NAMES[subjectCode] || subjectCode,
                    count: 0
                });
            }
        }
        
        const total = counts.reduce((sum, item) => sum + item.count, 0);
        
        // Calculate total with limits
        let totalWithLimits = 0;
        counts.forEach(subject => {
            const limit = subject.subject === 'ENG' ? QUESTION_LIMITS['ENG'] : QUESTION_LIMITS['DEFAULT'];
            totalWithLimits += Math.min(subject.count, limit);
        });
        
        res.json({ 
            success: true, 
            counts: counts,
            total: total,
            total_with_limits: totalWithLimits
        });
    } catch (error) {
        console.error('Error getting question counts:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Database error' 
        });
    }
});

// GET QUESTIONS WITH FIXED LIMITS (NO SHUFFLING) - WITH IMAGE SUPPORT
router.post('/questions-fixed', async (req, res) => {
    const { subjects, year } = req.body;
    
    console.log('📥 Request for questions with FIXED limits (no shuffling):', { subjects, year });
    
    if (!subjects || !Array.isArray(subjects) || subjects.length === 0) {
        return res.status(400).json({ 
            success: false, 
            message: 'Please select at least one subject' 
        });
    }
    
    if (!year) {
        return res.status(400).json({ 
            success: false, 
            message: 'Please select a year' 
        });
    }
    
    if (!dbConnected) {
        // Return demo questions
        const demoQuestions = [];
        let questionId = 1;
        
        for (const subjectCode of subjects) {
            const limit = subjectCode === 'ENG' ? QUESTION_LIMITS['ENG'] : QUESTION_LIMITS['DEFAULT'];
            
            for (let i = 1; i <= Math.min(limit, 10); i++) {
                demoQuestions.push({
                    id: questionId++,
                    question_number: i,
                    year: year,
                    question_text: `Demo question ${i} for ${SUBJECT_NAMES[subjectCode]}`,
                    option_a: 'Option A',
                    option_b: 'Option B',
                    option_c: 'Option C',
                    option_d: 'Option D',
                    correct_answer: i % 4 === 0 ? 'A' : i % 4 === 1 ? 'B' : i % 4 === 2 ? 'C' : 'D',
                    topic: 'Introduction',
                    explanation: 'This is a demo explanation for the question.',
                    subject_code: subjectCode,
                    subject_name: SUBJECT_NAMES[subjectCode] || subjectCode,
                    has_image: false
                });
            }
        }
        
        return res.json({ 
            success: true, 
            questions: demoQuestions 
        });
    }
    
    try {
        const questions = [];
        
        for (const subjectCode of subjects) {
            const tableName = SUBJECT_TABLES[subjectCode];
            const limit = subjectCode === 'ENG' ? QUESTION_LIMITS['ENG'] : QUESTION_LIMITS['DEFAULT'];
            
            if (!tableName) continue;
            
            try {
                // Check if table exists
                const tableCheck = await pool.query(
                    `SELECT EXISTS (
                        SELECT FROM information_schema.tables 
                        WHERE table_schema = 'public' 
                        AND table_name = $1
                    )`,
                    [tableName]
                );
                
                if (!tableCheck.rows[0].exists) continue;
                
                // Get actual columns from the table
                const columnsResult = await pool.query(`
                    SELECT column_name 
                    FROM information_schema.columns 
                    WHERE table_name = $1
                `, [tableName]);
                
                const existingColumns = columnsResult.rows.map(row => row.column_name);
                
                // Build SELECT query with only existing columns
                let selectColumns = ['id', 'question_number', 'year', 'question_text', 
                                    'option_a', 'option_b', 'option_c', 'option_d', 'correct_answer'];
                
                // Add optional columns only if they exist
                const optionalColumns = ['topic', 'explanation', 'has_image', 'image_url', 'image_filename'];
                optionalColumns.forEach(col => {
                    if (existingColumns.includes(col)) {
                        selectColumns.push(col);
                    }
                });
                
                const query = `
                    SELECT ${selectColumns.join(', ')}
                    FROM ${tableName}
                    WHERE year = $1
                    ORDER BY question_number
                    LIMIT $2
                `;
                
                const result = await pool.query(query, [year, limit]);
                
                const questionsWithSubject = result.rows.map(question => ({
                    id: question.id,
                    question_number: question.question_number,
                    year: question.year,
                    question_text: question.question_text,
                    option_a: question.option_a,
                    option_b: question.option_b,
                    option_c: question.option_c,
                    option_d: question.option_d,
                    correct_answer: question.correct_answer,
                    topic: question.topic || null,
                    explanation: question.explanation || null,
                    subject_code: subjectCode,
                    subject_name: SUBJECT_NAMES[subjectCode] || subjectCode,
                    has_image: question.has_image || question.image_filename ? true : false,
                    image_filename: question.image_filename || null
                }));
                
                questions.push(...questionsWithSubject);
                console.log(`✅ Found ${result.rows.length} questions from ${tableName}`);
            } catch (error) {
                console.error(`Error fetching ${subjectCode} questions:`, error.message);
                continue;
            }
        }
        
        if (questions.length === 0) {
            return res.json({
                success: true,
                message: 'No questions found.',
                questions: []
            });
        }
        
        console.log(`✅ Found ${questions.length} questions total`);
        
        res.json({ 
            success: true, 
            questions: questions 
        });
    } catch (error) {
        console.error('Error fetching questions:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Database error' 
        });
    }
});

// ============================================
// GET QUESTION IMAGE - SERVE FROM LOCAL FILES
// ============================================
router.get('/question-image/:subject/:id', async (req, res) => {
    const { subject, id } = req.params;
    const tableName = SUBJECT_TABLES[subject];
    
    console.log(`🖼️ Image request for ${subject} question ${id}`);
    
    if (!tableName) {
        console.log(`❌ Subject table not found: ${subject}`);
        return res.redirect('https://via.placeholder.com/600x400/3498db/ffffff?text=Subject+Not+Found');
    }
    
    try {
        // Get the image_filename from the database
        const result = await pool.query(
            `SELECT image_filename FROM ${tableName} WHERE id = $1`,
            [id]
        );
        
        if (result.rows.length === 0 || !result.rows[0].image_filename) {
            console.log(`❌ No image filename found for ${subject} question ${id}`);
            return res.redirect('https://via.placeholder.com/600x400/3498db/ffffff?text=No+Image+in+Database');
        }
        
        const imageFilename = result.rows[0].image_filename;
        console.log(`🔍 Looking for image: ${imageFilename} for ${subject} question ${id}`);
        
        // List of possible directories to search for images (based on your code)
        const possiblePaths = [
            // Current working directory
            path.join(process.cwd(), 'pictures'),
            path.join(__dirname, 'pictures'),
            path.join(process.cwd(), 'images'),
            path.join(__dirname, 'images'),
            path.join(process.cwd(), 'math_images'),
            path.join(__dirname, 'math_images'),
            path.join(process.cwd(), 'physics_images'),
            path.join(__dirname, 'physics_images'),
            path.join(process.cwd(), 'chemistry_images'),
            path.join(__dirname, 'chemistry_images'),
            path.join(process.cwd(), 'biology_images'),
            path.join(__dirname, 'biology_images'),
            path.join(process.cwd(), 'english_images'),
            path.join(__dirname, 'english_images'),
            path.join(process.cwd(), 'commerce_images'),
            path.join(__dirname, 'commerce_images'),
            path.join(process.cwd(), 'accounting_images'),
            path.join(__dirname, 'accounting_images'),
            path.join(process.cwd(), 'government_images'),
            path.join(__dirname, 'government_images'),
            path.join(process.cwd(), 'economics_images'),
            path.join(__dirname, 'economics_images'),
            path.join(process.cwd(), 'geography_images'),
            path.join(__dirname, 'geography_images'),
            path.join(process.cwd(), 'crs_images'),
            path.join(__dirname, 'crs_images'),
            path.join(process.cwd(), 'irs_images'),
            path.join(__dirname, 'irs_images'),
            path.join(process.cwd(), 'literature_images'),
            path.join(__dirname, 'literature_images'),
            path.join(process.cwd(), 'agric_images'),
            path.join(__dirname, 'agric_images'),
            path.join(process.cwd(), 'history_images'),
            path.join(__dirname, 'history_images'),
            path.join(process.cwd(), 'french_images'),
            path.join(__dirname, 'french_images'),
            path.join(process.cwd(), 'ict_images'),
            path.join(__dirname, 'ict_images'),
            path.join(process.cwd(), 'home_economics_images'),
            path.join(__dirname, 'home_economics_images'),
            // Also check the root directory
            process.cwd(),
            __dirname
        ];
        
        // Try to find the image file
        let imagePath = null;
        for (const dir of possiblePaths) {
            const testPath = path.join(dir, imageFilename);
            console.log(`Checking: ${testPath}`);
            if (fs.existsSync(testPath)) {
                imagePath = testPath;
                console.log(`✅ Found image at: ${testPath}`);
                break;
            }
        }
        
        // Also try with subject-specific subdirectories
        if (!imagePath) {
            const subjectLower = subject.toLowerCase();
            const subjectDirs = [
                path.join(process.cwd(), 'pictures', subjectLower),
                path.join(__dirname, 'pictures', subjectLower),
                path.join(process.cwd(), 'images', subjectLower),
                path.join(__dirname, 'images', subjectLower),
                path.join(process.cwd(), subjectLower + '_images'),
                path.join(__dirname, subjectLower + '_images'),
            ];
            
            for (const dir of subjectDirs) {
                const testPath = path.join(dir, imageFilename);
                console.log(`Checking subject dir: ${testPath}`);
                if (fs.existsSync(testPath)) {
                    imagePath = testPath;
                    console.log(`✅ Found image in subject dir at: ${testPath}`);
                    break;
                }
            }
        }
        
        // If image found, serve it
        if (imagePath && fs.existsSync(imagePath)) {
            // Determine content type based on file extension
            const ext = path.extname(imagePath).toLowerCase();
            let contentType = 'image/jpeg';
            
            if (ext === '.png') {
                contentType = 'image/png';
            } else if (ext === '.gif') {
                contentType = 'image/gif';
            } else if (ext === '.webp') {
                contentType = 'image/webp';
            } else if (ext === '.svg') {
                contentType = 'image/svg+xml';
            } else if (ext === '.bmp') {
                contentType = 'image/bmp';
            }
            
            res.setHeader('Content-Type', contentType);
            res.setHeader('Cache-Control', 'public, max-age=86400'); // Cache for 24 hours
            
            // Send the file
            return res.sendFile(imagePath);
        }
        
        // If image not found, try to serve from your Supabase storage as fallback
        console.log(`❌ Image file not found locally for: ${imageFilename}`);
        
        // Try Supabase storage as fallback
        const supabaseUrl = process.env.SUPABASE_URL || 'https://vbpehelxdstkasscjiov.supabase.co';
        const baseUrl = supabaseUrl.replace(/\/$/, '');
        const storageUrl = `${baseUrl}/storage/v1/object/public/question-images/${imageFilename}`;
        
        console.log(`Trying Supabase storage: ${storageUrl}`);
        
        // Fetch the image from Supabase
        try {
            const fetch = require('node-fetch');
            const response = await fetch(storageUrl);
            
            if (response.ok) {
                const imageBuffer = await response.buffer();
                const contentType = response.headers.get('content-type') || 'image/jpeg';
                
                res.setHeader('Content-Type', contentType);
                res.setHeader('Cache-Control', 'public, max-age=86400');
                return res.send(imageBuffer);
            }
        } catch (fetchError) {
            console.error('Error fetching from Supabase storage:', fetchError.message);
        }
        
        // If all else fails, redirect to placeholder
        return res.redirect('https://via.placeholder.com/600x400/3498db/ffffff?text=Image+Not+Found');
        
    } catch (error) {
        console.error('Error in image endpoint:', error);
        return res.redirect('https://via.placeholder.com/600x400/3498db/ffffff?text=Error+Loading+Image');
    }
});

// ============================================
// SUBMIT EXAM
// ============================================
router.post('/submit', async (req, res) => {
    const { answers } = req.body;
    
    console.log('📤 Processing exam submission with', answers?.length || 0, 'answers');
    
    if (!answers || !Array.isArray(answers) || answers.length === 0) {
        return res.status(400).json({ 
            success: false, 
            message: 'No answers provided' 
        });
    }
    
    if (!dbConnected) {
        // Generate demo results if database not connected
        return generateDemoResults(answers, res);
    }
    
    try {
        const detailedResults = [];
        let correctCount = 0;
        let totalTime = 0;
        
        // Group answers by subject for efficient querying
        const answersBySubject = {};
        answers.forEach(answer => {
            if (!answersBySubject[answer.subjectCode]) {
                answersBySubject[answer.subjectCode] = [];
            }
            answersBySubject[answer.subjectCode].push(answer);
            totalTime += answer.timeTaken || 0;
        });
        
        // Process each subject
        for (const [subjectCode, subjectAnswers] of Object.entries(answersBySubject)) {
            const tableName = SUBJECT_TABLES[subjectCode];
            
            if (!tableName) {
                // Subject table not found
                subjectAnswers.forEach(answer => {
                    detailedResults.push({
                        questionId: answer.questionId,
                        subjectCode,
                        subjectName: SUBJECT_NAMES[subjectCode] || subjectCode,
                        userAnswer: answer.userAnswer,
                        correctAnswer: 'N/A',
                        questionText: 'Subject not found',
                        options: { 'A': '', 'B': '', 'C': '', 'D': '' },
                        isCorrect: false,
                        timeTaken: answer.timeTaken || 0,
                        explanation: 'Subject table not found in database'
                    });
                });
                continue;
            }
            
            // Get actual columns from the table
            const columnsResult = await pool.query(`
                SELECT column_name 
                FROM information_schema.columns 
                WHERE table_name = $1
            `, [tableName]);
            
            const existingColumns = columnsResult.rows.map(row => row.column_name);
            
            // Build SELECT query with only existing columns
            let selectColumns = ['id', 'question_text', 'option_a', 'option_b', 'option_c', 'option_d', 'correct_answer'];
            
            // Add optional columns only if they exist
            if (existingColumns.includes('explanation')) {
                selectColumns.push('explanation');
            }
            if (existingColumns.includes('topic')) {
                selectColumns.push('topic');
            }
            
            const questionIds = subjectAnswers.map(a => a.questionId);
            const placeholders = questionIds.map((_, i) => `$${i + 1}`).join(',');
            
            const query = `
                SELECT ${selectColumns.join(', ')}
                FROM ${tableName}
                WHERE id IN (${placeholders})
            `;
            
            const result = await pool.query(query, questionIds);
            
            // Create map for quick lookup
            const questionsMap = {};
            result.rows.forEach(q => {
                questionsMap[q.id] = q;
            });
            
            // Process each answer for this subject
            for (const answer of subjectAnswers) {
                const question = questionsMap[answer.questionId];
                
                if (!question) {
                    // Question not found in database
                    detailedResults.push({
                        questionId: answer.questionId,
                        subjectCode,
                        subjectName: SUBJECT_NAMES[subjectCode] || subjectCode,
                        userAnswer: answer.userAnswer,
                        correctAnswer: 'N/A',
                        questionText: 'Question not found in database',
                        options: { 'A': '', 'B': '', 'C': '', 'D': '' },
                        isCorrect: false,
                        timeTaken: answer.timeTaken || 0,
                        explanation: 'Question data not available in database'
                    });
                    continue;
                }
                
                // Convert correct_answer to letter format
                let correctAnswerLetter = convertToLetter(question.correct_answer, question);
                
                // Determine if user's answer is correct
                const isCorrect = answer.userAnswer === correctAnswerLetter;
                
                if (isCorrect) correctCount++;
                
                // Add detailed result with all information from database
                detailedResults.push({
                    questionId: answer.questionId,
                    subjectCode,
                    subjectName: SUBJECT_NAMES[subjectCode] || subjectCode,
                    userAnswer: answer.userAnswer || 'Not answered',
                    correctAnswer: correctAnswerLetter,
                    correctAnswerText: getOptionText(question, correctAnswerLetter),
                    questionText: question.question_text,
                    options: {
                        'A': question.option_a,
                        'B': question.option_b,
                        'C': question.option_c,
                        'D': question.option_d
                    },
                    isCorrect: isCorrect,
                    timeTaken: answer.timeTaken || 0,
                    explanation: question.explanation || 'No explanation available',
                    topic: question.topic || 'General'
                });
            }
        }
        
        // Calculate summary statistics
        const totalQuestions = detailedResults.length;
        const score = totalQuestions > 0 ? Math.round((correctCount / totalQuestions) * 100) : 0;
        const averageTime = totalQuestions > 0 ? Math.round(totalTime / totalQuestions) : 0;
        
        // Calculate subject-wise results
        const subjectResults = {};
        detailedResults.forEach(result => {
            if (!subjectResults[result.subjectCode]) {
                subjectResults[result.subjectCode] = {
                    subjectName: result.subjectName,
                    total: 0,
                    correct: 0
                };
            }
            subjectResults[result.subjectCode].total++;
            if (result.isCorrect) subjectResults[result.subjectCode].correct++;
        });
        
        const subjectResultsArray = Object.values(subjectResults).map(subject => ({
            ...subject,
            score: subject.total > 0 ? Math.round((subject.correct / subject.total) * 100) : 0
        }));
        
        // Save exam results if user is logged in
        if (req.session && req.session.userId) {
            try {
                // Create exam_results table if it doesn't exist
                await pool.query(`
                    CREATE TABLE IF NOT EXISTS exam_results (
                        id SERIAL PRIMARY KEY,
                        user_id INTEGER,
                        score INTEGER NOT NULL,
                        total_questions INTEGER NOT NULL,
                        correct_answers INTEGER NOT NULL,
                        subjects JSONB,
                        duration INTEGER,
                        created_at TIMESTAMP DEFAULT NOW()
                    )
                `);
                
                await pool.query(
                    `INSERT INTO exam_results 
                     (user_id, score, total_questions, correct_answers, subjects, duration, created_at)
                     VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
                    [
                        req.session.userId, 
                        score, 
                        totalQuestions, 
                        correctCount, 
                        JSON.stringify(Object.keys(answersBySubject)), 
                        averageTime
                    ]
                );
                console.log('✅ Exam results saved to database');
            } catch (saveError) {
                console.error('Error saving exam results:', saveError);
                // Continue even if save fails
            }
        }
        
        // Send response with all results
        res.json({
            success: true,
            summary: {
                totalQuestions,
                correctAnswers: correctCount,
                wrongAnswers: totalQuestions - correctCount,
                score,
                percentage: `${score}%`,
                averageTimePerQuestion: averageTime
            },
            subjectResults: subjectResultsArray,
            detailedResults: detailedResults
        });
        
    } catch (error) {
        console.error('Error processing exam submission:', error);
        
        // Fall back to demo results on error
        generateDemoResults(answers, res);
    }
});

// Helper function to get option text
function getOptionText(question, letter) {
    if (!question || !letter) return '';
    
    switch(letter) {
        case 'A': return question.option_a || '';
        case 'B': return question.option_b || '';
        case 'C': return question.option_c || '';
        case 'D': return question.option_d || '';
        default: return '';
    }
}

// Helper function to generate demo results
function generateDemoResults(answers, res) {
    const detailedResults = answers.map((answer, index) => ({
        questionId: answer.questionId,
        subjectCode: answer.subjectCode,
        subjectName: SUBJECT_NAMES[answer.subjectCode] || answer.subjectCode,
        userAnswer: answer.userAnswer,
        correctAnswer: ['A', 'B', 'C', 'D'][index % 4],
        correctAnswerText: `Option ${['A', 'B', 'C', 'D'][index % 4]}`,
        questionText: `Demo Question ${index + 1}`,
        options: {
            'A': 'Option A - First choice',
            'B': 'Option B - Second choice',
            'C': 'Option C - Third choice',
            'D': 'Option D - Fourth choice'
        },
        isCorrect: Math.random() > 0.4,
        timeTaken: answer.timeTaken || 10000,
        explanation: 'This is a demo explanation. In production, this would come from your database.',
        topic: 'General'
    }));
    
    const correctCount = detailedResults.filter(r => r.isCorrect).length;
    const totalQuestions = detailedResults.length;
    const totalTime = detailedResults.reduce((sum, r) => sum + (r.timeTaken || 0), 0);
    
    res.json({
        success: true,
        summary: {
            totalQuestions,
            correctAnswers: correctCount,
            wrongAnswers: totalQuestions - correctCount,
            score: Math.round((correctCount / totalQuestions) * 100),
            percentage: `${Math.round((correctCount / totalQuestions) * 100)}%`,
            averageTimePerQuestion: Math.round(totalTime / totalQuestions)
        },
        subjectResults: [],
        detailedResults
    });
}

// Helper function to convert answer to letter
function convertToLetter(correctAnswer, question) {
    if (!correctAnswer) return null;
    
    // If it's already a letter (A, B, C, D)
    if (['A', 'B', 'C', 'D'].includes(correctAnswer.toUpperCase())) {
        return correctAnswer.toUpperCase();
    }
    
    // If it's in format "option_a", "option_b", etc.
    if (correctAnswer.toLowerCase().startsWith('option_')) {
        const letter = correctAnswer.toLowerCase().replace('option_', '');
        return letter.toUpperCase();
    }
    
    // If it matches one of the option texts
    if (question) {
        if (correctAnswer === question.option_a) return 'A';
        if (correctAnswer === question.option_b) return 'B';
        if (correctAnswer === question.option_c) return 'C';
        if (correctAnswer === question.option_d) return 'D';
    }
    
    // Default fallback
    return correctAnswer;
}

// CHECK TABLES STATUS
router.get('/tables-status', async (req, res) => {
    try {
        const status = [];
        
        for (const [subjectCode, tableName] of Object.entries(SUBJECT_TABLES)) {
            const result = await pool.query(
                `SELECT EXISTS (
                    SELECT FROM information_schema.tables 
                    WHERE table_schema = 'public' 
                    AND table_name = $1
                ) as exists`,
                [tableName]
            );
            
            let count = 0;
            let columns = [];
            
            if (result.rows[0].exists) {
                const countResult = await pool.query(`SELECT COUNT(*) as count FROM ${tableName}`);
                count = parseInt(countResult.rows[0].count);
                
                const columnsResult = await pool.query(`
                    SELECT column_name 
                    FROM information_schema.columns 
                    WHERE table_name = $1
                `, [tableName]);
                
                columns = columnsResult.rows.map(row => row.column_name);
            }
            
            status.push({
                subject: subjectCode,
                table: tableName,
                exists: result.rows[0].exists,
                row_count: count,
                columns: columns
            });
        }
        
        res.json({ 
            success: true, 
            tables_status: status 
        });
    } catch (error) {
        console.error('Error checking tables:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Database error' 
        });
    }
});

// HEALTH CHECK
router.get('/health', async (req, res) => {
    try {
        const result = await pool.query('SELECT NOW() as time');
        res.json({ 
            status: 'ok', 
            database: 'connected',
            server_time: new Date().toISOString(),
            db_time: result.rows[0].time,
            dbConnected: dbConnected
        });
    } catch (error) {
        res.json({ 
            status: 'error', 
            database: 'disconnected',
            error: error.message,
            server_time: new Date().toISOString(),
            dbConnected: dbConnected
        });
    }
});

// LOGOUT
router.post('/logout', (req, res) => {
    if (req.session) {
        req.session.destroy();
    }
    res.json({ success: true });
});

module.exports = router;