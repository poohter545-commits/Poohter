const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const pool = require('../config/db');
const { createEmailOtp, normalizeEmail, verifyEmailOtp } = require('../utils/emailOtp');

const PASSWORD_REGEX = /^(?=.*[0-9])(?=.*[!@#$%^&*(),.?":{}|<>]).*$/;
const JWT_SECRET = process.env.JWT_SECRET || 'your_default_secret';

const validatePassword = (password, confirmPassword) => {
  if (typeof password !== 'string' || password.length < 6) {
    return 'Password must be at least 6 characters long.';
  }
  if (confirmPassword !== undefined && password !== confirmPassword) {
    return 'Passwords do not match.';
  }
  if (!PASSWORD_REGEX.test(password)) {
    return 'Password must contain at least one number and one special character.';
  }
  return '';
};

const signUserToken = (user) => jwt.sign(
  { id: user.id, email: user.email, role: user.role },
  JWT_SECRET,
  { expiresIn: '1h' }
);

const normalizeAccountType = (accountType) => {
  const cleanType = String(accountType || 'buyer').trim().toLowerCase();
  return ['buyer', 'seller', 'wholesaler'].includes(cleanType) ? cleanType : 'buyer';
};

const findAccountByEmail = async (accountType, email) => {
  if (accountType === 'seller') {
    const result = await pool.query('SELECT id, name, email FROM sellers WHERE LOWER(email) = LOWER($1)', [email]);
    return result.rows[0];
  }
  if (accountType === 'wholesaler') {
    const result = await pool.query('SELECT id, name, email FROM wholesalers WHERE LOWER(email) = LOWER($1)', [email]);
    return result.rows[0];
  }
  const result = await pool.query('SELECT id, name, email FROM users WHERE LOWER(email) = LOWER($1)', [email]);
  return result.rows[0];
};

const updateAccountPassword = async (accountType, email, hashedPassword) => {
  if (accountType === 'seller') {
    return pool.query('UPDATE sellers SET password = $1 WHERE LOWER(email) = LOWER($2) RETURNING id', [hashedPassword, email]);
  }
  if (accountType === 'wholesaler') {
    return pool.query('UPDATE wholesalers SET password = $1 WHERE LOWER(email) = LOWER($2) RETURNING id', [hashedPassword, email]);
  }
  return pool.query('UPDATE users SET password = $1 WHERE LOWER(email) = LOWER($2) RETURNING id', [hashedPassword, email]);
};

const signup = async (req, res, next) => {
  try {
    const { name, email, password, confirmPassword, phone, address } = req.body;
    const cleanEmail = normalizeEmail(email);

    if (!name || !cleanEmail || !password || !confirmPassword || !phone || !address) {
      return res.status(400).json({ error: 'Name, email, password, confirm password, phone, and address are required' });
    }

    const passwordError = validatePassword(password, confirmPassword);
    if (passwordError) return res.status(400).json({ error: passwordError });

    // Check if user already exists
    const userExists = await pool.query('SELECT id FROM users WHERE LOWER(email) = LOWER($1)', [cleanEmail]);
    if (userExists.rows.length > 0) {
      return res.status(400).json({ error: 'User already exists' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    await createEmailOtp({
      email: cleanEmail,
      purpose: 'signup',
      accountType: 'buyer',
      displayName: name,
      payload: {
        name,
        email: cleanEmail,
        password_hash: hashedPassword,
        phone,
        address,
        role: 'buyer',
      },
    });

    res.status(202).json({
      message: 'Verification code sent to your email. Enter the OTP to create your buyer account.',
      requiresOtp: true,
      email: cleanEmail,
    });
  } catch (error) {
    next(error);
  }
};

const verifySignup = async (req, res, next) => {
  try {
    const { email, otp } = req.body;
    const cleanEmail = normalizeEmail(email);
    const pendingUser = await verifyEmailOtp({
      email: cleanEmail,
      purpose: 'signup',
      accountType: 'buyer',
      otp,
    });

    const userExists = await pool.query('SELECT id FROM users WHERE LOWER(email) = LOWER($1)', [cleanEmail]);
    if (userExists.rows.length > 0) {
      return res.status(400).json({ error: 'User already exists' });
    }

    const result = await pool.query(
      'INSERT INTO users (name, email, password, phone, address, role) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, name, email, role',
      [
        pendingUser.name,
        pendingUser.email,
        pendingUser.password_hash,
        pendingUser.phone,
        pendingUser.address,
        'buyer',
      ]
    );

    const user = result.rows[0];

    res.status(201).json({
      message: 'Email verified. User registered successfully.',
      user,
      token: signUserToken(user)
    });
  } catch (error) {
    next(error);
  }
};

const login = async (req, res, next) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    // 1. Find user by email
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    const user = result.rows[0];

    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // 2. Compare passwords
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // 3. Generate JWT Token
    // 4. Send response (preventing the hang)
    res.status(200).json({
      message: 'Login successful',
      user: { id: user.id, name: user.name, email: user.email, role: user.role },
      token: signUserToken(user)
    });
  } catch (error) {
    next(error);
  }
};

const requestPasswordReset = async (req, res, next) => {
  try {
    const cleanEmail = normalizeEmail(req.body.email);
    const accountType = normalizeAccountType(req.body.accountType);
    const account = cleanEmail ? await findAccountByEmail(accountType, cleanEmail) : null;

    if (account) {
      await createEmailOtp({
        email: cleanEmail,
        purpose: 'password_reset',
        accountType,
        displayName: account.name,
      });
    }

    res.json({
      message: 'If this email exists, a password reset OTP has been sent.',
      requiresOtp: true,
      email: cleanEmail,
    });
  } catch (error) {
    next(error);
  }
};

const resetPassword = async (req, res, next) => {
  try {
    const cleanEmail = normalizeEmail(req.body.email);
    const accountType = normalizeAccountType(req.body.accountType);
    const passwordError = validatePassword(req.body.password, req.body.confirmPassword);
    if (passwordError) return res.status(400).json({ error: passwordError });

    await verifyEmailOtp({
      email: cleanEmail,
      purpose: 'password_reset',
      accountType,
      otp: req.body.otp,
    });

    const hashedPassword = await bcrypt.hash(req.body.password, 10);
    const result = await updateAccountPassword(accountType, cleanEmail, hashedPassword);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Account not found.' });
    }

    res.json({ message: 'Password changed successfully. You can login with your new password.' });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  signup,
  verifySignup,
  login,
  requestPasswordReset,
  resetPassword,
};
