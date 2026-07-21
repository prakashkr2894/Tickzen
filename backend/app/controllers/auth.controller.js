import User from '../models/User.js';
import TrialAdmin from '../models/TrialAdmin.js';
import AdminAccount from '../models/AdminAccount.js';
import { generateToken } from '../middleware/auth.middleware.js';
import mongoose from 'mongoose';
import crypto from 'crypto';
import Razorpay from 'razorpay';
import SibApiV3Sdk from 'sib-api-v3-sdk';
import { OAuth2Client } from 'google-auth-library';

const ADMIN_PLAN_AMOUNT = Number(process.env.ADMIN_PLAN_AMOUNT || 99);
const OTP_EXPIRY_MS = 5 * 60 * 1000;
const VERIFIED_SIGNUP_EXPIRY_MS = 15 * 60 * 1000;
const otpStore = new Map();
const verifiedSignupStore = new Map();
let googleClient;

// Purge expired entries every 10 minutes to prevent unbounded memory growth.
// Full Redis migration is the long-term solution for multi-pod deployments.
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of otpStore) {
    if (now > val.expires) otpStore.delete(key);
  }
  for (const [key, val] of verifiedSignupStore) {
    if (now > val.expires) verifiedSignupStore.delete(key);
  }
}, 10 * 60 * 1000);

const getRazorpayClient = () => {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;

  if (!keyId || !keySecret) {
    throw new Error('Razorpay is not configured. Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET.');
  }

  return new Razorpay({
    key_id: keyId,
    key_secret: keySecret,
  });
};

const createAdminUserRecord = async ({
  name,
  email,
  password,
  paymentAmount,
  paymentReference,
  avatar = '',
}) => {
  const existingUser = await User.findOne({ email });
  if (existingUser) {
    return { error: 'User with this email already exists', status: 400 };
  }

  const adminUser = new User({
    name,
    email,
    password: password || crypto.randomBytes(24).toString('hex'),
    role: 'admin',
    isPaidAdmin: true,
    avatar,
  });

  await adminUser.save();

  try {
    const adminAccount = new AdminAccount({
      userId: adminUser._id,
      name,
      email,
      paymentAmount,
      paymentReference,
      paymentStatus: 'paid',
    });

    await adminAccount.save();

    const token = generateToken(adminUser._id);

    return {
      status: 201,
      payload: {
        message: 'Admin account created successfully',
        token,
        user: {
          id: adminUser._id,
          name: adminUser.name,
          email: adminUser.email,
          role: adminUser.role,
        },
        adminAccount: {
          paymentAmount: adminAccount.paymentAmount,
          paymentReference: adminAccount.paymentReference,
          paidAt: adminAccount.paidAt,
        },
      },
    };
  } catch (adminAccountError) {
    await User.findByIdAndDelete(adminUser._id);
    throw adminAccountError;
  }
};

const ensureDatabaseConnection = (res) => {
  if (mongoose.connection.readyState !== 1) {
    res.status(503).json({
      message: 'Database unavailable. Check MongoDB connection and try again.',
    });
    return false;
  }

  return true;
};

const getBrevoEmailApi = () => {
  const apiKeyValue = process.env.BREVO_API_KEY;
  if (!apiKeyValue) {
    throw new Error('Brevo is not configured. Set BREVO_API_KEY.');
  }

  const client = SibApiV3Sdk.ApiClient.instance;
  client.authentications['api-key'].apiKey = apiKeyValue;

  return new SibApiV3Sdk.TransactionalEmailsApi();
};

const getGoogleClient = () => {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) {
    throw new Error('Google OAuth is not configured. Set GOOGLE_CLIENT_ID.');
  }

  if (!googleClient) {
    googleClient = new OAuth2Client(clientId);
  }

  return googleClient;
};

const verifyGoogleCredential = async (credential) => {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const client = getGoogleClient();
  const ticket = await client.verifyIdToken({
    idToken: credential,
    audience: clientId,
  });

  return ticket.getPayload();
};

const generateOTP = () => Math.floor(100000 + Math.random() * 900000).toString();

const saveOTP = (email, otp) => {
  otpStore.set(email.toLowerCase(), {
    otp,
    expires: Date.now() + OTP_EXPIRY_MS,
  });
};

const getStoredOTP = (email) => otpStore.get(email.toLowerCase());

const clearOTP = (email) => {
  otpStore.delete(email.toLowerCase());
};

const saveVerifiedSignup = (email) => {
  const token = crypto.randomBytes(32).toString('hex');

  verifiedSignupStore.set(token, {
    email: email.toLowerCase(),
    expires: Date.now() + VERIFIED_SIGNUP_EXPIRY_MS,
  });

  return token;
};

const verifySignupToken = (token, email) => {
  const record = verifiedSignupStore.get(token);
  if (!record) {
    return { valid: false, reason: 'Signup verification has expired. Please verify your email again.' };
  }

  if (Date.now() > record.expires) {
    verifiedSignupStore.delete(token);
    return { valid: false, reason: 'Signup verification has expired. Please verify your email again.' };
  }

  if (record.email !== email.toLowerCase()) {
    return { valid: false, reason: 'Verification token does not match this email address.' };
  }

  return { valid: true };
};

const clearVerifiedSignup = (token) => {
  verifiedSignupStore.delete(token);
};

const verifyStoredOTP = (email, userOtp) => {
  const record = getStoredOTP(email);
  if (!record) {
    return { valid: false, reason: 'OTP not found. Please request a new OTP.' };
  }

  if (Date.now() > record.expires) {
    clearOTP(email);
    return { valid: false, reason: 'OTP has expired. Please request a new OTP.' };
  }

  if (record.otp !== userOtp) {
    return { valid: false, reason: 'Invalid OTP.' };
  }

  return { valid: true };
};

const sendOTPEmail = async (email, otp, purpose = 'signup') => {
  const senderEmail = process.env.BREVO_SENDER_EMAIL;
  const senderName = process.env.BREVO_SENDER_NAME || 'Tickzen';

  if (!senderEmail) {
    throw new Error('Brevo sender is not configured. Set BREVO_SENDER_EMAIL.');
  }

  const tranEmailApi = getBrevoEmailApi();

  await tranEmailApi.sendTransacEmail({
    sender: { email: senderEmail, name: senderName },
    to: [{ email }],
    subject: `Your Tickzen OTP Code`,
    htmlContent: `
      <div style="font-family: Arial, sans-serif; color: #222;">
        <h2 style="margin-bottom: 12px;">${purpose === 'login' ? 'Sign in to Tickzen' : 'Verify your email'}</h2>
        <p style="margin-bottom: 16px;">Use the OTP below to ${purpose === 'login' ? 'complete your Tickzen sign in.' : 'complete your Tickzen signup.'}</p>
        <div style="font-size: 32px; font-weight: 700; letter-spacing: 8px; margin: 20px 0;">${otp}</div>
        <p style="margin-top: 16px;">This code expires in 5 minutes.</p>
      </div>
    `,
  });
};

// Register new user
export const signup = async (req, res) => {
  try {
    if (!ensureDatabaseConnection(res)) {
      return;
    }

    const { name, email, password } = req.body;

    // Check if user already exists
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({ message: 'User with this email already exists' });
    }

    // Create new user
    const user = new User({
      name,
      email,
      password,
      role: 'developer'
    });

    await user.save();

    // Generate token
    const token = generateToken(user._id);

    res.status(201).json({
      message: 'User registered successfully',
      token,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role
      }
    });
  } catch (error) {
    console.error('Signup error:', error);
    res.status(500).json({ message: 'Error registering user', error: error.message });
  }
};

export const sendSignupOtp = async (req, res) => {
  try {
    if (!ensureDatabaseConnection(res)) {
      return;
    }

    const { email } = req.body;
    const normalizedEmail = email.toLowerCase();

    const existingUser = await User.findOne({ email: normalizedEmail });
    if (existingUser) {
      return res.status(400).json({ message: 'User with this email already exists' });
    }

    const otp = generateOTP();
    await sendOTPEmail(normalizedEmail, otp, 'signup');
    saveOTP(normalizedEmail, otp);

    res.json({ message: 'OTP sent successfully' });
  } catch (error) {
    console.error('Send signup OTP error:', error);
    res.status(500).json({ message: 'Unable to send OTP', error: error.message });
  }
};

export const sendLoginOtp = async (req, res) => {
  try {
    if (!ensureDatabaseConnection(res)) {
      return;
    }

    const { email } = req.body;
    const normalizedEmail = email.toLowerCase();

    const existingUser = await User.findOne({ email: normalizedEmail });
    if (!existingUser) {
      return res.status(404).json({ message: 'No account found with this email' });
    }

    const otp = generateOTP();
    await sendOTPEmail(normalizedEmail, otp, 'login');
    saveOTP(normalizedEmail, otp);

    res.json({ message: 'OTP sent successfully' });
  } catch (error) {
    console.error('Send login OTP error:', error);
    res.status(500).json({ message: 'Unable to send OTP', error: error.message });
  }
};

export const getGoogleAuthConfig = async (req, res) => {
  try {
    const clientId = process.env.GOOGLE_CLIENT_ID;

    if (!clientId) {
      return res.status(500).json({ message: 'Google OAuth is not configured.' });
    }

    res.json({ clientId });
  } catch (error) {
    console.error('Get Google auth config error:', error);
    res.status(500).json({ message: 'Unable to load Google auth config', error: error.message });
  }
};

export const googleAuth = async (req, res) => {
  try {
    if (!ensureDatabaseConnection(res)) {
      return;
    }

    const { credential } = req.body;
    const payload = await verifyGoogleCredential(credential);

    if (!payload?.email || !payload.email_verified) {
      return res.status(400).json({ message: 'Google account email is not verified.' });
    }

    const normalizedEmail = payload.email.toLowerCase();
    let user = await User.findOne({ email: normalizedEmail });

    if (user?.role === 'admin') {
      return res.status(403).json({
        message: 'Admin accounts must continue through the admin signup and payment flow.',
      });
    }

    if (!user) {
      const generatedPassword = crypto.randomBytes(24).toString('hex');
      user = new User({
        name: payload.name || normalizedEmail.split('@')[0],
        email: normalizedEmail,
        password: generatedPassword,
        role: 'developer',
        avatar: payload.picture || '',
      });

      await user.save();
    } else if (payload.picture && user.avatar !== payload.picture) {
      user.avatar = payload.picture;
      await user.save();
    }

    const token = generateToken(user._id);

    res.json({
      message: 'Google authentication successful',
      token,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        avatar: user.avatar,
      },
    });
  } catch (error) {
    console.error('Google auth error:', error);
    res.status(500).json({ message: 'Unable to authenticate with Google', error: error.message });
  }
};

export const verifySignupOtp = async (req, res) => {
  try {
    if (!ensureDatabaseConnection(res)) {
      return;
    }

    const { name, email, password, otp, role } = req.body;
    const normalizedEmail = email.toLowerCase();

    // Role must be explicitly provided — no silent defaulting
    if (!role || !['developer', 'trial-admin'].includes(role)) {
      return res.status(400).json({
        message: 'Account type is required. Choose Developer or Trial Admin.',
      });
    }

    const existingUser = await User.findOne({ email: normalizedEmail });
    if (existingUser) {
      return res.status(400).json({ message: 'User with this email already exists' });
    }

    const otpResult = verifyStoredOTP(normalizedEmail, otp);
    if (!otpResult.valid) {
      return res.status(400).json({ message: otpResult.reason });
    }

    let userFields = {
      name,
      email: normalizedEmail,
      password: password || crypto.randomBytes(24).toString('hex'),
      role: 'developer',
    };

    if (role === 'trial-admin') {
      const trialUser = await TrialAdmin.findOne({ email: normalizedEmail });
      if (trialUser) {
        return res.status(400).json({
          message: 'This email has already used the 30-minute free admin access.',
          trialAlreadyUsed: true,
          redirectTo: '/signup',
        });
      }
      const trialExpiry = new Date(Date.now() + 30 * 60 * 1000); // 30 minutes
      const trialAdmin = new TrialAdmin({
        ...userFields,
        role: 'admin',
        isTrialAdmin: true,
        trialExpiresAt: trialExpiry,
      });
      await trialAdmin.save();
      clearOTP(normalizedEmail);
      const token = generateToken(trialAdmin._id);
      return res.status(201).json({
        message: 'User registered successfully',
        token,
        user: { id: trialAdmin._id, name: trialAdmin.name, email: trialAdmin.email, role: trialAdmin.role, isTrialAdmin: trialAdmin.isTrialAdmin, trialExpiresAt: trialAdmin.trialExpiresAt },
      });
    }

    const user = new User(userFields);
    await user.save();
    clearOTP(normalizedEmail);
    const token = generateToken(user._id);

    res.status(201).json({
      message: 'User registered successfully',
      token,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        isTrialAdmin: user.isTrialAdmin,
        trialExpiresAt: user.trialExpiresAt,
      },
    });
  } catch (error) {
    console.error('Verify signup OTP error:', error);
    res.status(500).json({ message: 'Unable to verify OTP', error: error.message });
  }
};

export const verifyLoginOtp = async (req, res) => {
  try {
    if (!ensureDatabaseConnection(res)) {
      return;
    }

    const { email, otp } = req.body;
    const normalizedEmail = email.toLowerCase();

    let isTrial = false;
    let user = await User.findOne({ email: normalizedEmail });
    
    if (!user) {
      user = await TrialAdmin.findOne({ email: normalizedEmail });
      if (user) isTrial = true;
    }

    if (!user) {
      return res.status(404).json({ message: 'No account found with this email' });
    }

    const otpResult = verifyStoredOTP(normalizedEmail, otp);
    if (!otpResult.valid) {
      return res.status(400).json({ message: otpResult.reason });
    }

    clearOTP(normalizedEmail);

    // Trial admin expiry check
    if (user.isTrialAdmin && user.trialExpiresAt) {
      const now = new Date();
      if (now > new Date(user.trialExpiresAt)) {
        return res.status(403).json({
          message: 'Your 30-minute admin trial has expired. Please complete payment to continue.',
          trialExpired: true,
          redirectTo: '/signup',
        });
      }
    }

    const token = generateToken(user._id);

    res.json({
      message: 'Login successful',
      token,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        isTrialAdmin: user.isTrialAdmin || false,
        trialExpiresAt: user.trialExpiresAt || null,
      },
    });
  } catch (error) {
    console.error('Verify login OTP error:', error);
    res.status(500).json({ message: 'Unable to verify OTP', error: error.message });
  }
};

export const verifySignupEmailOtp = async (req, res) => {
  try {
    if (!ensureDatabaseConnection(res)) {
      return;
    }

    const { email, otp } = req.body;
    const normalizedEmail = email.toLowerCase();

    const existingUser = await User.findOne({ email: normalizedEmail });
    if (existingUser) {
      return res.status(400).json({ message: 'User with this email already exists' });
    }

    const existingTrial = await TrialAdmin.findOne({ email: normalizedEmail });
    const trialAlreadyUsed = !!existingTrial;
    
    const otpResult = verifyStoredOTP(normalizedEmail, otp);
    if (!otpResult.valid) {
      return res.status(400).json({ message: otpResult.reason });
    }

    clearOTP(normalizedEmail);
    const verificationToken = saveVerifiedSignup(normalizedEmail);

    res.json({
      message: 'Email verified successfully',
      verificationToken,
      trialAlreadyUsed,
    });
  } catch (error) {
    console.error('Verify signup email OTP error:', error);
    res.status(500).json({ message: 'Unable to verify OTP', error: error.message });
  }
};

export const completeVerifiedSignup = async (req, res) => {
  try {
    if (!ensureDatabaseConnection(res)) {
      return;
    }

    const { name, email, password, verificationToken, role } = req.body;
    const normalizedEmail = email.toLowerCase();

    // Role must be explicitly provided
    if (!role || !['developer', 'trial-admin'].includes(role)) {
      return res.status(400).json({
        message: 'Account type is required. Choose Developer or Trial Admin.',
      });
    }

    const existingUser = await User.findOne({ email: normalizedEmail });
    if (existingUser) {
      return res.status(400).json({ message: 'User with this email already exists' });
    }

    const verificationResult = verifySignupToken(verificationToken, normalizedEmail);
    if (!verificationResult.valid) {
      return res.status(400).json({ message: verificationResult.reason });
    }

    let userFields = {
      name,
      email: normalizedEmail,
      password,
      role: 'developer',
    };

    if (role === 'trial-admin') {
      const trialUser = await TrialAdmin.findOne({ email: normalizedEmail });
      if (trialUser) {
        return res.status(400).json({
          message: 'This email has already used the 30-minute free admin access.',
          trialAlreadyUsed: true,
          redirectTo: '/signup',
        });
      }
      const trialExpiry = new Date(Date.now() + 30 * 60 * 1000);
      const trialAdmin = new TrialAdmin({
        ...userFields,
        role: 'admin',
        isTrialAdmin: true,
        trialExpiresAt: trialExpiry,
      });
      await trialAdmin.save();
      clearVerifiedSignup(verificationToken);
      const token = generateToken(trialAdmin._id);
      return res.status(201).json({
        message: 'User registered successfully',
        token,
        user: { id: trialAdmin._id, name: trialAdmin.name, email: trialAdmin.email, role: trialAdmin.role, isTrialAdmin: trialAdmin.isTrialAdmin, trialExpiresAt: trialAdmin.trialExpiresAt },
      });
    }

    const user = new User(userFields);
    await user.save();
    clearVerifiedSignup(verificationToken);

    const token = generateToken(user._id);

    res.status(201).json({
      message: 'User registered successfully',
      token,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        isTrialAdmin: user.isTrialAdmin,
        trialExpiresAt: user.trialExpiresAt,
      },
    });
  } catch (error) {
    console.error('Complete verified signup error:', error);
    res.status(500).json({ message: 'Unable to create account', error: error.message });
  }
};

// Register new admin after payment
export const signupAdmin = async (req, res) => {
  try {
    if (!ensureDatabaseConnection(res)) {
      return;
    }

    const { name, email, password, paymentAmount, paymentReference, paymentStatus } = req.body;

    if (paymentStatus !== 'paid') {
      return res.status(400).json({ message: 'Admin signup requires a completed payment.' });
    }

    const result = await createAdminUserRecord({
      name,
      email,
      password,
      paymentAmount,
      paymentReference,
    });

    if (result.error) {
      return res.status(result.status).json({ message: result.error });
    }

    res.status(result.status).json(result.payload);
  } catch (error) {
    console.error('Admin signup error:', error);

    res.status(500).json({ message: 'Error registering admin', error: error.message });
  }
};

export const createAdminOrder = async (req, res) => {
  try {
    const razorpay = getRazorpayClient();
    const order = await razorpay.orders.create({
      amount: ADMIN_PLAN_AMOUNT * 100,
      currency: 'INR',
      receipt: `admin_${Date.now()}`,
      notes: {
        plan: 'Tickzen Admin',
      },
    });

    res.status(201).json({
      order,
      keyId: process.env.RAZORPAY_KEY_ID,
      amount: ADMIN_PLAN_AMOUNT,
      currency: 'INR',
    });
  } catch (error) {
    console.error('Create admin order error:', error);
    res.status(500).json({ message: 'Unable to create Razorpay order', error: error.message });
  }
};

export const verifyAdminPayment = async (req, res) => {
  try {
    if (!ensureDatabaseConnection(res)) {
      return;
    }

    const {
      name,
      email,
      password,
      googleCredential,
      razorpayOrderId,
      razorpayPaymentId,
      razorpaySignature,
    } = req.body;

    const secret = process.env.RAZORPAY_KEY_SECRET;
    if (!secret) {
      return res.status(500).json({ message: 'Razorpay secret is not configured.' });
    }

    const expectedSignature = crypto
      .createHmac('sha256', secret)
      .update(`${razorpayOrderId}|${razorpayPaymentId}`)
      .digest('hex');

    if (expectedSignature !== razorpaySignature) {
      return res.status(400).json({ message: 'Payment signature verification failed.' });
    }

    let finalName = name;
    let finalEmail = email;
    let finalPassword = password;
    let finalAvatar = '';

    if (googleCredential) {
      const payload = await verifyGoogleCredential(googleCredential);

      if (!payload?.email || !payload.email_verified) {
        return res.status(400).json({ message: 'Google account email is not verified.' });
      }

      if (payload.email.toLowerCase() !== email.toLowerCase()) {
        return res.status(400).json({ message: 'Google account email does not match the payment email.' });
      }

      finalName = payload.name || name;
      finalEmail = payload.email.toLowerCase();
      finalPassword = '';
      finalAvatar = payload.picture || '';
    }

    const result = await createAdminUserRecord({
      name: finalName,
      email: finalEmail.toLowerCase(),
      password: finalPassword,
      paymentAmount: ADMIN_PLAN_AMOUNT,
      paymentReference: razorpayPaymentId,
      avatar: finalAvatar,
    });

    if (result.error) {
      return res.status(result.status).json({ message: result.error });
    }

    res.status(result.status).json(result.payload);
  } catch (error) {
    console.error('Verify admin payment error:', error);
    res.status(500).json({ message: 'Unable to verify payment', error: error.message });
  }
};

// Login user
export const login = async (req, res) => {
  try {
    if (!ensureDatabaseConnection(res)) {
      return;
    }

    const { email, password } = req.body;

    // Find user by email
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(401).json({ message: 'Invalid email or password' });
    }

    // Check password
    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      return res.status(401).json({ message: 'Invalid email or password' });
    }

    // Generate token
    const token = generateToken(user._id);

    res.json({
      message: 'Login successful',
      token,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ message: 'Error logging in', error: error.message });
  }
};

// Get current user profile
export const getProfile = async (req, res) => {
  try {
    if (!ensureDatabaseConnection(res)) {
      return;
    }

    const user = await User.findById(req.userId)
      .populate('joinedProjects', 'name description progress')
      .select('-password');

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    res.json({ user });
  } catch (error) {
    console.error('Get profile error:', error);
    res.status(500).json({ message: 'Error fetching profile', error: error.message });
  }
};

// Update user profile
export const updateProfile = async (req, res) => {
  try {
    if (!ensureDatabaseConnection(res)) {
      return;
    }

    const { name, email } = req.body;
    const avatarPath = req.file ? `/uploads/${req.file.filename}` : req.body.avatar;

    const user = await User.findById(req.userId);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    if (name) user.name = name;
    if (email && email !== user.email) {
      const existingUser = await User.findOne({ email });
      if (existingUser) {
        return res.status(400).json({ message: 'Email already in use' });
      }
      user.email = email;
    }

    if (typeof avatarPath === 'string') {
      user.avatar = avatarPath;
    }

    await user.save();

    res.json({
      message: 'Profile updated successfully',
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        avatar: user.avatar
      }
    });
  } catch (error) {
    console.error('Update profile error:', error);
    res.status(500).json({ message: 'Error updating profile', error: error.message });
  }
};

// Get all developers (for admin to invite)
export const getDevelopers = async (req, res) => {
  try {
    if (!ensureDatabaseConnection(res)) {
      return;
    }

    const developers = await User.find({ role: 'developer' })
      .select('name email joinedProjects')
      .populate('joinedProjects', 'name');

    res.json({ developers });
  } catch (error) {
    console.error('Get developers error:', error);
    res.status(500).json({ message: 'Error fetching developers', error: error.message });
  }
};

// Get all users (admin only)
export const getAllUsers = async (req, res) => {
  try {
    if (!ensureDatabaseConnection(res)) {
      return;
    }

    const search = (req.query.search || '').toString().trim();
    const query = { role: 'developer' };

    if (search) {
      const escapedSearch = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      query.$or = [
        { name: { $regex: escapedSearch, $options: 'i' } },
        { email: { $regex: escapedSearch, $options: 'i' } },
      ];
    }

    const users = await User.find(query)
      .select('-password')
      .populate('joinedProjects', 'name')
      .sort({ createdAt: -1 });

    res.json({ users });
  } catch (error) {
    console.error('Get all users error:', error);
    res.status(500).json({ message: 'Error fetching users', error: error.message });
  }
};

// Get all admins (admin only - for project co-admin selection)
export const getAdmins = async (req, res) => {
  try {
    if (!ensureDatabaseConnection(res)) {
      return;
    }

    const search = (req.query.search || '').toString().trim();
    const query = { role: 'admin' };

    if (search) {
      const escapedSearch = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      query['$or'] = [
        { name: { '$regex': escapedSearch, '$options': 'i' } },
        { email: { '$regex': escapedSearch, '$options': 'i' } },
      ];
    }

    const admins = await User.find(query)
      .select('name email avatar role')
      .sort({ name: 1 });

    res.json({ admins });
  } catch (error) {
    console.error('Get admins error:', error);
    res.status(500).json({ message: 'Error fetching admins', error: error.message });
  }
};
