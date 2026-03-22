const express = require('express');
const router = express.Router();
const { Pool } = require('pg'); // PostgreSQL
const path = require('path');
const nodemailer = require('nodemailer');
require('dotenv').config();

// ==================== SENDGRID EMAIL SETUP ====================
const sgMail = require('@sendgrid/mail');
sgMail.setApiKey('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');

// PostgreSQL connection (Supabase)
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Test connection
pool.connect((err, client, release) => {
    if (err) {
        console.error('❌ Database connection error:', err.message);
    } else {
        console.log('✅ Connected to PostgreSQL (VerifyCode Router)');
        release();
    }
});

// Email validation function
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
};

// Generate activation code
function generateActivationCode() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

// Welcome/activation page
router.get("/send", (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'activationcode.html'));
});

// Handle activation code request - UPDATED with SendGrid
router.post("/send", async (req, res) => {
    const { email } = req.body;
    
    // Validation
    if (!email || !isRealisticEmail(email)) {
        return res.status(400).json({ 
            success: false, 
            message: "Valid email is required" 
        });
    }
    
    const activationCode = generateActivationCode();
    const cleanEmail = email.trim().toLowerCase();
    
    try {
        // Check if user has made payment (PostgreSQL)
        const checkPaymentQuery = `
            SELECT * FROM user_payments 
            WHERE email = $1
        `;
        
        const paymentResult = await pool.query(checkPaymentQuery, [cleanEmail]);
        
        if (paymentResult.rows.length === 0) {
            return res.status(400).json({ 
                success: false, 
                message: "User has not made payment" 
            });
        }
        
        // Check if user exists in jambuser table
        const checkUserQuery = `
            SELECT * FROM jambuser 
            WHERE email = $1
        `;
        
        const userResult = await pool.query(checkUserQuery, [cleanEmail]);
        
        if (userResult.rows.length === 0) {
            return res.status(400).json({ 
                success: false, 
                message: "User not found. Please register first." 
            });
        }
        
        // Update activation code - using "activationCode" with quotes for camelCase
        const updateQuery = `
            UPDATE jambuser 
            SET "activationCode" = $1 
            WHERE email = $2
            RETURNING id, "userName", email
        `;
        
        const updateResult = await pool.query(updateQuery, [activationCode, cleanEmail]);
        
        console.log(`✅ Activation code ${activationCode} updated for ${cleanEmail}`);
        
        // Send email with activation code using SendGrid
        const emailContent = `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                <div style="background: linear-gradient(135deg, #1a237e 0%, #311b92 100%); padding: 30px; text-align: center;">
                    <h1 style="color: white; margin: 0;">🎯 JAMB Practice</h1>
                </div>
                <div style="padding: 30px; background: white;">
                    <h2 style="color: #1a237e;">Account Activation Code</h2>
                    <p>Hello ${userResult.rows[0].userName || 'User'},</p>
                    <p>Thank you for registering with JAMB Practice. Here is your activation code:</p>
                    <div style="background: #f8f9fa; padding: 20px; text-align: center; margin: 20px 0; border-radius: 10px; border: 2px dashed #1a237e;">
                        <div style="font-size: 2.5rem; font-weight: bold; color: #1a237e; letter-spacing: 5px;">
                            ${activationCode}
                        </div>
                    </div>
                    <p>Enter this code on the activation page to complete your account setup.</p>
                    <p>This code will expire in 24 hours.</p>
                    <div style="margin-top: 30px; padding-top: 20px; border-top: 1px solid #e0e0e0;">
                        <p style="color: #666; font-size: 0.9rem;">
                            If you didn't request this code, please ignore this email.<br>
                            Best regards,<br>
                            The JAMB Practice Team
                        </p>
                    </div>
                </div>
            </div>
        `;

        const msg = {
            to: cleanEmail,
            from: 'piotech52@gmail.com',
            subject: "Your Account Activation Code",
            html: emailContent
        };
        
        await sgMail.send(msg);
        
        console.log(`📧 Activation email sent to ${cleanEmail}`);
        
        res.json({
            success: true,
            message: 'Activation code sent successfully',
            email: cleanEmail,
            note: 'Check your email for the activation code'
        });
        
    } catch (error) {
        console.error('❌ Error in /send route:', error.message);
        
        let errorMessage = "Server error";
        if (error.code === '23505') {
            errorMessage = "Database constraint error";
        } else if (error.code === 'ECONNREFUSED') {
            errorMessage = "Database connection failed";
        } else if (error.command === 'UPDATE') {
            errorMessage = "Failed to update activation code";
        }
        
        res.status(500).json({ 
            success: false, 
            message: errorMessage,
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

// Verify activation code - UPDATED to redirect to home.html (NOT homeforall.html)
router.post("/verify-code", async (req, res) => {
    const { activationCode } = req.body;
    
    if (!activationCode) {
        return res.status(400).json({ 
            success: false, 
            message: "Activation code is required" 
        });
    }
    
    try {
        // Verify using "activationCode" column (with quotes because of camelCase)
        const verifyQuery = `
            SELECT * FROM jambuser 
            WHERE "activationCode" = $1
        `;
        
        const result = await pool.query(verifyQuery, [activationCode]);
        
        if (result.rows.length === 0) {
            return res.json({
                success: false,
                message: "Invalid activation code"
            });
        }

        const user = result.rows[0];
        
        // Update user: clear activationCode and set is_activated to '1'
        const updateQuery = `
            UPDATE jambuser 
            SET "activationCode" = NULL, is_activated = '1' 
            WHERE id = $1
            RETURNING id, "userName", email, is_activated
        `;
        
        const updateResult = await pool.query(updateQuery, [user.id]);
        
        console.log(`✅ User ${user.email} activated successfully. is_activated set to '1'`);
        
        // Set user session
        req.session.userId = updateResult.rows[0].id;
        req.session.userEmail = updateResult.rows[0].email;
        req.session.userName = updateResult.rows[0].userName;
        req.session.isActivated = true;
        req.session.loggedIn = true;
        
        // Return success with redirect to home.html (YOUR CORRECT HOME PAGE)
        res.json({
            success: true,
            message: "Activation successful! Redirecting to homepage...",
            user: {
                id: updateResult.rows[0].id,
                email: updateResult.rows[0].email,
                username: updateResult.rows[0].userName,
                is_activated: updateResult.rows[0].is_activated
            },
            redirect: "/home.html" // ✅ Redirect to home.html, NOT homeforall.html
        });

    } catch (error) {
        console.error('❌ Verification error:', error.message);
        res.status(500).json({ 
            success: false, 
            message: "Server error during verification. Please try again." 
        });
    }
});

// Alternative verify endpoint with email - UPDATED to redirect to home.html
router.post("/verify-code-with-email", async (req, res) => {
    const { email, activationCode } = req.body;
    
    if (!email || !activationCode) {
        return res.status(400).json({ 
            success: false, 
            message: "Email and activation code are required" 
        });
    }
    
    try {
        const verifyQuery = `
            SELECT * FROM jambuser 
            WHERE email = $1 AND "activationCode" = $2
        `;
        
        const result = await pool.query(verifyQuery, [email, activationCode]);
        
        if (result.rows.length === 0) {
            return res.json({
                success: false,
                message: "Invalid activation code or email"
            });
        }

        const user = result.rows[0];
        
        // Update user: clear activationCode and set is_activated to '1'
        const updateQuery = `
            UPDATE jambuser 
            SET "activationCode" = NULL, is_activated = '1' 
            WHERE id = $1
            RETURNING id, "userName", email, is_activated
        `;
        
        const updateResult = await pool.query(updateQuery, [user.id]);
        
        console.log(`✅ User ${email} activated successfully via email+code. is_activated='1'`);
        
        // Set user session
        req.session.userId = updateResult.rows[0].id;
        req.session.userEmail = updateResult.rows[0].email;
        req.session.userName = updateResult.rows[0].userName;
        req.session.isActivated = true;
        req.session.loggedIn = true;
        
        res.json({
            success: true,
            message: "Activation successful! Redirecting to homepage...",
            user: {
                id: updateResult.rows[0].id,
                email: updateResult.rows[0].email,
                username: updateResult.rows[0].userName,
                is_activated: updateResult.rows[0].is_activated
            },
            redirect: "/home.html" // ✅ Redirect to home.html, NOT homeforall.html
        });
        
    } catch (error) {
        console.error('Verification error:', error);
        res.status(500).json({ 
            success: false, 
            message: "Server error" 
        });
    }
});

// Add a route to check if a user is activated
router.get("/check-activation/:email", async (req, res) => {
    const { email } = req.params;
    
    try {
        const query = `
            SELECT email, "userName", is_activated, "activationCode" 
            FROM jambuser 
            WHERE email = $1
        `;
        
        const result = await pool.query(query, [email]);
        
        if (result.rows.length === 0) {
            return res.json({
                success: false,
                message: "User not found"
            });
        }
        
        res.json({
            success: true,
            user: {
                email: result.rows[0].email,
                username: result.rows[0].userName,
                is_activated: result.rows[0].is_activated === '1',
                has_activation_code: !!result.rows[0].activationCode
            }
        });
        
    } catch (error) {
        console.error('Error checking activation:', error);
        res.status(500).json({ 
            success: false, 
            message: "Server error" 
        });
    }
});

// Session check endpoint for home.html
router.get("/api/session", (req, res) => {
    if (req.session && req.session.loggedIn && req.session.isActivated) {
        res.json({
            loggedIn: true,
            user: {
                id: req.session.userId,
                email: req.session.userEmail,
                userName: req.session.userName,
                is_activated: true
            }
        });
    } else {
        res.json({
            loggedIn: false
        });
    }
});

// Logout endpoint
router.post("/api/logout", (req, res) => {
    req.session.destroy((err) => {
        if (err) {
            return res.status(500).json({ success: false, message: 'Logout failed' });
        }
        res.json({ success: true, message: 'Logged out' });
    });
});
  
module.exports = router;