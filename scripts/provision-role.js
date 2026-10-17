import 'dotenv/config';
import mongoose from 'mongoose';
import { z } from 'zod';
import { connectDatabase } from '../src/config/database.js';
import { User } from '../src/models/User.js';

const args = process.argv.slice(2);
const input = z.tuple([z.string().email(), z.enum(['student','founder','reviewer','mentor','admin'])]).safeParse(args);
if (!input.success) {
  console.error('Usage: npm run provision-role -- <existing-account-email> <student|founder|reviewer|mentor|admin>');
  process.exitCode = 1;
} else {
  try {
    await connectDatabase();
    const [emailInput, role] = input.data;
    const user = await User.findOne({ email: emailInput.toLowerCase() });
    if (!user) throw new Error('No account exists for that email. Create and verify the account before assigning a role.');
    if (user.role === 'admin' && user.status === 'active' && role !== 'admin' && await User.countDocuments({ role: 'admin', status: 'active' }) <= 1) {
      throw new Error('At least one active admin account must remain.');
    }
    if (user.role === role) {
      console.log('The account already has the requested role.');
    } else {
      user.accessHistory.push({ source: 'bootstrap', previousRole: user.role, role, previousStatus: user.status, status: user.status });
      if (user.accessHistory.length > 50) user.accessHistory = user.accessHistory.slice(-50);
      user.role = role;
      user.tokenVersion += 1;
      await user.save();
      console.log(`Role assigned: ${role}. The account owner must sign in again to receive a new session.`);
    }
  } catch (error) {
    console.error(`Role provisioning failed: ${error.message}`);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
}
