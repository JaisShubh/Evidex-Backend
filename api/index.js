import mongoose from 'mongoose';
import { app } from '../src/app.js';
import { connectDatabase } from '../src/config/database.js';
import { getMatchingWeights } from '../src/services/matching.service.js';

getMatchingWeights();

let connectionPromise;

async function ensureDatabaseConnection() {
  if (mongoose.connection.readyState === 1) return;

  if (!connectionPromise || [0, 3].includes(mongoose.connection.readyState)) {
    connectionPromise = connectDatabase().catch((error) => {
      connectionPromise = undefined;
      throw error;
    });
  }

  await connectionPromise;
}

export default async function handler(req, res) {
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
    return res.status(500).json({
      error: { code: 'SERVER_CONFIGURATION_ERROR', message: 'Server is not configured.' },
    });
  }

  try {
    await ensureDatabaseConnection();
    return app(req, res);
  } catch (error) {
    console.error('API initialization failed:', error?.message);
    return res.status(503).json({
      error: { code: 'SERVICE_UNAVAILABLE', message: 'Service is temporarily unavailable.' },
    });
  }
}
