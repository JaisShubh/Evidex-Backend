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
  const path = String(req.url || '');
  if (/deconstruct|generate-draft|score-suggestions/.test(path)) {
    // #region agent log
    fetch('http://127.0.0.1:7676/ingest/e70e87b2-7ab0-43a9-8dce-a651dd7efd6a',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'526782'},body:JSON.stringify({sessionId:'526782',runId:'pre-fix',hypothesisId:'A',location:'api/index.js:handler',message:'serverless AI route',data:{path,hasGeminiKey:Boolean(process.env.GEMINI_API_KEY),hasGeminiModel:Boolean(process.env.GEMINI_MODEL),vercelEnv:process.env.VERCEL_ENV||null},timestamp:Date.now()})}).catch(()=>{});
    // #endregion
  }
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
